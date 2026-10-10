const { query, inClauseSafe } = require('../db');
const {
  queryList,
  buildDeptHistory,
  buildDeptTrend,
  getDelayHistory,
  SUSPENDED_EPISODE_SQL,
} = require('./delayed.service');
const {
  businessToday,
  daysBetween,
  addDays,
  effectiveStatus,
  addMonthsClamped,
  CYCLE_MONTHS,
} = require('../utils/dates');
const holidayService = require('./holiday.service');

const ALL_STATUSES = [
  'needs_maintenance',
  'in_maintenance',
  'pending_approval',
  'rejected',
  'not_due',
];
const ALL_CYCLES = ['1_week', '2_weeks', '1_month', '1_year'];
const ALL_REASONS = ['not_started', 'in_progress', 'awaiting_approval', 'rejected'];
const DUE_FILTERS = ['today', 'tomorrow', 'normal', 'overdue'];
const CYCLE_LABEL_MAP = {
  '1_week': '1 Week Maint',
  '2_weeks': '2 Week Maint',
  '1_month': 'Monthly Maint',
  '1_year': 'Yearly Maint',
};

async function getOverview() {
  await holidayService.ensureHolidaysLoaded();
  const today = businessToday();
  const rows = await query(
    'SELECT use_date, max_mt_date, maintenance_type, maintenance_status, mnt_dept_no FROM eqm_mnt',
  );

  const statusMap = new Map();
  const cycleMap = new Map();
  const deptDeviceMap = new Map();
  const deptDueMap = new Map();
  const cycleStatMap = new Map();
  for (const cycle of ALL_CYCLES) cycleStatMap.set(cycle, { unmaintained: 0, expected: 0, actual: 0 });

  for (const row of rows) {
    const device = {
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
      maintenanceStatus: row.maintenance_status,
    };
    const nextDue = holidayService.getAdjustedDueDay(device);
    const displayStatus = effectiveStatus(device, today, nextDue);
    statusMap.set(displayStatus, (statusMap.get(displayStatus) || 0) + 1);

    const cycle = ALL_CYCLES.includes(row.maintenance_type) ? row.maintenance_type : '1_month';
    cycleMap.set(cycle, (cycleMap.get(cycle) || 0) + 1);

    const stat = cycleStatMap.get(cycle);
    stat.expected += 1;
    if (displayStatus === 'not_due') stat.actual += 1;
    else stat.unmaintained += 1;

    if (row.mnt_dept_no) {
      deptDeviceMap.set(row.mnt_dept_no, (deptDeviceMap.get(row.mnt_dept_no) || 0) + 1);
      const diffDays = daysBetween(today, nextDue);
      const prev = deptDueMap.get(row.mnt_dept_no) || { today: 0, tomorrow: 0, normal: 0, overdue: 0, total: 0 };
      prev.total += 1;
      if (diffDays < 0) prev.overdue += 1;
      else if (diffDays === 0) prev.today += 1;
      else if (diffDays === 1) prev.tomorrow += 1;
      else prev.normal += 1;
      deptDueMap.set(row.mnt_dept_no, prev);
    }
  }

  const statusCounts = ALL_STATUSES.map((status) => ({ status, count: statusMap.get(status) || 0 }));
  const cycleCounts = ALL_CYCLES.map((cycle) => ({ cycle, count: cycleMap.get(cycle) || 0 }));

  // Cho duyet = trach nhiem nguoi duyet: khong dem vao so "dang tre han" (2026-10-08)
  const delayedReasonRows = await query(
    `SELECT reason, COUNT(*) AS count FROM eqm_mnt_delay d
     WHERE d.resolved_at IS NULL AND ${SUSPENDED_EPISODE_SQL}
     GROUP BY reason`,
  );
  const delayedByReason = ALL_REASONS.map((reason) => ({
    reason,
    count: (delayedReasonRows.find((r) => r.reason === reason) || {}).count || 0,
  }));
  const delayedTotal = delayedByReason.reduce((sum, r) => sum + r.count, 0);

  const delayedDeptRows = await query(
    `SELECT mnt_dept_no AS dept, COUNT(*) AS count FROM eqm_mnt_delay d
     WHERE d.resolved_at IS NULL AND ${SUSPENDED_EPISODE_SQL}
     GROUP BY mnt_dept_no`,
  );
  const deptDelayedMap = new Map();
  for (const r of delayedDeptRows) {
    if (r.dept) deptDelayedMap.set(r.dept, r.count);
  }

  const deptCodes = [...new Set([...deptDeviceMap.keys(), ...deptDelayedMap.keys()])];
  const deptNameMap = new Map();
  if (deptCodes.length > 0) {
    const { sql: inSql, params } = inClauseSafe(deptCodes, 'd');
    const deptRows = await query(
      `SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt WHERE mnt_dept_no IN (${inSql})`,
      params,
    );
    for (const r of deptRows) deptNameMap.set(r.mnt_dept_no, r.mnt_dept_name || r.mnt_dept_no);
  }
  const departmentCounts = deptCodes.map((code) => ({
    departmentCode: code,
    departmentName: deptNameMap.get(code) || code,
    deviceCount: deptDeviceMap.get(code) || 0,
    delayedCount: deptDelayedMap.get(code) || 0,
  }));

  const departmentDueStats = [...deptDueMap.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([code, stat]) => ({
      departmentCode: code,
      departmentName: deptNameMap.get(code) || code,
      today: stat.today,
      tomorrow: stat.tomorrow,
      normal: stat.normal,
      overdue: stat.overdue,
      total: stat.total,
    }));

  const cycleMaintStats = ALL_CYCLES.map((cycle) => {
    const stat = cycleStatMap.get(cycle);
    return {
      cycle,
      cycleLabel: CYCLE_LABEL_MAP[cycle],
      unmaintained: stat.unmaintained,
      expected: stat.expected,
      actual: stat.actual,
    };
  });

  const dayStart = new Date(`${today}T00:00:00+07:00`);
  const dayEnd = new Date(`${addDays(today, 1)}T00:00:00+07:00`);
  const completedRows = await query(
    'SELECT COUNT(*) AS total FROM eqm_mt1 WHERE sheet_date >= @s AND sheet_date < @e',
    { s: dayStart, e: dayEnd },
  );
  const completedToday = completedRows[0] ? completedRows[0].total : 0;

  const lastRows = await query('SELECT MAX(snapshot_at) AS last FROM eqm_mnt_delay');
  const lastSyncedAt = lastRows[0] && lastRows[0].last ? new Date(lastRows[0].last).toISOString() : null;

  const episodeTotalRows = await query('SELECT COUNT(*) AS cnt FROM eqm_mnt_delay');
  const delayedHistoryTotal = episodeTotalRows[0] ? episodeTotalRows[0].cnt : 0;
  const deptDelayHistory = await buildDeptHistory();
  const deptDelayTrend = await buildDeptTrend(365);

  const cycleStatsRows = await query(
    `SELECT mnt_dept_no AS dept, maintenance_type AS mtype, COUNT(*) AS cnt
     FROM eqm_mnt_delay GROUP BY mnt_dept_no, maintenance_type`,
  );
  const cycleStatsMap = new Map();
  for (const r of cycleStatsRows) {
    const key = r.dept || '';
    if (!cycleStatsMap.has(key)) {
      cycleStatsMap.set(key, {
        departmentCode: key,
        departmentName: key,
        total: 0,
        cycleCounts: { '1_week': 0, '2_weeks': 0, '1_month': 0, '1_year': 0 },
      });
    }
    const entry = cycleStatsMap.get(key);
    entry.total += Number(r.cnt);
    if (Object.prototype.hasOwnProperty.call(entry.cycleCounts, r.mtype)) {
      entry.cycleCounts[r.mtype] += Number(r.cnt);
    }
  }
  for (const entry of cycleStatsMap.values()) {
    entry.departmentName = deptNameMap.get(entry.departmentCode) || entry.departmentCode;
  }
  const deptDelayCycleStats = [...cycleStatsMap.values()].sort((a, b) => b.total - a.total);

  return {
    totalDevices: rows.length,
    completedToday,
    statusCounts,
    cycleCounts,
    departmentCounts,
    delayedTotal,
    delayedByReason,
    delayedHistoryTotal,
    deptDelayHistory,
    deptDelayTrend,
    deptDelayCycleStats,
    lastSyncedAt,
    departmentDueStats,
    cycleMaintStats,
  };
}

// Trang BI cong khai, khong can userId; pageSize mac dinh 30, toi da 100
async function getDelayedStatistics(reason, page, pageSize) {
  return queryList(reason || '', page, pageSize);
}

async function getEquipmentStatistics(params) {
  await holidayService.ensureHolidaysLoaded();
  const today = businessToday();
  const conditions = [];
  const values = {};
  if (params.factory) {
    conditions.push('mnt_dept_no = @factory');
    values.factory = params.factory;
  }
  if (params.empNo) {
    conditions.push('maintainer_emp_no = @empNo');
    values.empNo = params.empNo;
  }
  if (params.respEmpNo) {
    conditions.push('approver_emp_no = @respEmpNo');
    values.respEmpNo = params.respEmpNo;
  }
  if (params.maintType) {
    conditions.push('maintenance_type = @maintType');
    values.maintType = params.maintType;
  }
  if (params.equNo) {
    conditions.push('equ_no LIKE @equNo ESCAPE \'\\\'');
    values.equNo = `%${params.equNo.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  }
  if (params.maintenanceStatus) {
    conditions.push('maintenance_status = @maintenanceStatus');
    values.maintenanceStatus = params.maintenanceStatus;
  }
  let noMatch = false;
  if (ALL_REASONS.includes(params.delayReason)) {
    const delayRows = await query(
      `SELECT equ_no FROM eqm_mnt_delay d
       WHERE reason = @reason AND resolved_at IS NULL AND ${SUSPENDED_EPISODE_SQL}`,
      { reason: params.delayReason },
    );
    if (delayRows.length === 0) {
      noMatch = true;
    } else {
      const delayNos = delayRows.map((r) => r.equ_no);
      const { sql: inSql, params: inParams } = inClauseSafe(delayNos, 'd');
      conditions.push(`equ_no IN (${inSql})`);
      Object.assign(values, inParams);
    }
  }
  const whereSql = noMatch ? 'WHERE 1=0' : conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let dueNoMatch = false;
  let dueFilteredIds = null;
  if (DUE_FILTERS.includes(params.due)) {
    const baseRows = await query(
      `SELECT id, use_date, max_mt_date, maintenance_type FROM eqm_mnt ${whereSql}`,
      values,
    );
    const matched = [];
    for (const row of baseRows) {
      const nextDue = holidayService.getAdjustedDueDay({
        startDate: row.use_date,
        lastMaintenanceDate: row.max_mt_date,
        maintenanceCycle: row.maintenance_type,
      });
      const diffDays = daysBetween(today, nextDue);
      const category =
        diffDays < 0
          ? 'overdue'
          : diffDays === 0
            ? 'today'
            : diffDays === 1
              ? 'tomorrow'
              : 'normal';
      if (category === params.due) matched.push(row.id);
    }
    if (matched.length === 0) {
      dueNoMatch = true;
    } else {
      dueFilteredIds = matched;
    }
  }

  const finalNoMatch = noMatch || dueNoMatch;
  const finalConditions = [...conditions];
  if (dueFilteredIds) {
    const { sql: inSql, params: inParams } = inClauseSafe(dueFilteredIds, 'f');
    finalConditions.push(`id IN (${inSql})`);
    Object.assign(values, inParams);
  }
  const finalWhere = finalNoMatch
    ? 'WHERE 1=0'
    : finalConditions.length > 0
      ? `WHERE ${finalConditions.join(' AND ')}`
      : '';

  const totalRows = await query(`SELECT COUNT(*) AS total FROM eqm_mnt ${finalWhere}`, values);
  const total = totalRows[0] ? totalRows[0].total : 0;

  values.offset = (params.page - 1) * params.pageSize;
  values.pageSize = params.pageSize;
  const rows = await query(
    `SELECT id, equ_no, equ_name, equ_type, equ_type_desc, equ_addr,
      maintainer_emp_no, approver_emp_no, temp_maintainer_emp_no,
      maintenance_type, maintenance_status, use_date, max_mt_date, mnt_dept_no
     FROM eqm_mnt ${finalWhere}
     ORDER BY mnt_dept_no DESC, equ_type ASC, equ_no ASC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    values,
  );

  const empNos = [
    ...new Set(
      rows
        .flatMap((r) => [r.maintainer_emp_no, r.approver_emp_no, r.temp_maintainer_emp_no])
        .filter(Boolean),
    ),
  ];
  const empNameMap = new Map();
  if (empNos.length > 0) {
    const { sql: inSql, params } = inClauseSafe(empNos, 'e');
    const empRows = await query(`SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${inSql})`, params);
    for (const r of empRows) empNameMap.set(r.emp_no, r.emp_name || '');
  }

  const items = rows.map((row) => {
    const device = {
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
      maintenanceStatus: row.maintenance_status,
    };
    const nextDue = holidayService.getAdjustedDueDay(device);
    const daysOverdue = Math.max(0, -daysBetween(today, nextDue));
    const activeEmpNo =
      row.maintenance_status === 'in_maintenance' ||
      row.maintenance_status === 'pending_approval' ||
      row.maintenance_status === 'rejected'
        ? row.temp_maintainer_emp_no || row.maintainer_emp_no || null
        : null;
    return {
      id: String(row.id),
      equNo: row.equ_no,
      equName: row.equ_name,
      equType: row.equ_type || null,
      equTypeDesc: row.equ_type_desc || null,
      factory: row.equ_addr || null,
      maintainerEmpNo: row.maintainer_emp_no || null,
      maintainerName: row.maintainer_emp_no ? empNameMap.get(row.maintainer_emp_no) || null : null,
      responsibleEmpNo: row.approver_emp_no || null,
      responsibleName: row.approver_emp_no ? empNameMap.get(row.approver_emp_no) || null : null,
      activeMaintainerEmpNo: activeEmpNo,
      activeMaintainerName: activeEmpNo ? empNameMap.get(activeEmpNo) || null : null,
      maintenanceCycle: ALL_CYCLES.includes(row.maintenance_type) ? row.maintenance_type : '1_month',
      maintenanceStatus: row.maintenance_status,
      nextDueDate: nextDue,
      daysOverdue,
    };
  });

  const deptRows = await query('SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt ORDER BY mnt_dept_name ASC');
  const factories = deptRows.map((d) => ({ code: d.mnt_dept_no, name: d.mnt_dept_name || d.mnt_dept_no }));

  const maintTypes = ALL_CYCLES.map((c) => ({
    value: c,
    label: c === '1_week' ? '1 tuần' : c === '2_weeks' ? '2 tuần' : c === '1_month' ? '1 tháng' : '1 năm',
  }));

  const allEmpRows = await query(
    'SELECT emp_no, emp_name FROM emp_mnt WHERE position = \'nhan_vien_bao_tri\' ORDER BY emp_no ASC',
  );
  const empOptions = allEmpRows.map((e) => ({ empNo: e.emp_no, empName: e.emp_name || e.emp_no }));

  const allRespRows = await query(
    `SELECT emp_no, emp_name FROM emp_mnt
     WHERE position IN ('chu_quan', 'approver', 'van_thu') ORDER BY emp_no ASC`,
  );
  const respOptions = allRespRows.map((e) => ({ empNo: e.emp_no, empName: e.emp_name || e.emp_no }));

  return { items, total, page: params.page, pageSize: params.pageSize, factories, maintTypes, empOptions, respOptions };
}

async function listCompletedToday(factory, page, pageSize) {
  const today = businessToday();
  const dayStart = new Date(`${today}T00:00:00+07:00`);
  const dayEnd = new Date(`${addDays(today, 1)}T00:00:00+07:00`);
  const where = ['m.sheet_date >= @s AND m.sheet_date < @e'];
  const values = { s: dayStart, e: dayEnd };
  if (factory) {
    where.push('d.equ_addr = @factory');
    values.factory = factory;
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const totalRows = await query(
    `SELECT COUNT(*) AS total FROM eqm_mt1 m
      LEFT JOIN eqm_mnt d ON d.equ_no = m.equ_no
      ${whereSql}`,
    values,
  );
  const total = totalRows[0] ? totalRows[0].total : 0;
  const offset = (page - 1) * pageSize;
  const rows = await query(
    `SELECT m.sheet_no, m.sheet_date, m.equ_no, m.emp_no, m.mt_flag,
            d.equ_name, d.equ_addr, d.equ_type, d.equ_type_desc,
            d.maintainer_emp_no, d.approver_emp_no, d.temp_maintainer_emp_no,
            d.maintenance_type, d.max_mt_date, d.use_date
      FROM eqm_mt1 m
      LEFT JOIN eqm_mnt d ON d.equ_no = m.equ_no
      ${whereSql}
      ORDER BY m.sheet_date DESC, m.sheet_no DESC
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
    values,
  );
  const empNos = new Set();
  const deptNos = new Set();
  for (const r of rows) {
    if (r.maintainer_emp_no) empNos.add(r.maintainer_emp_no);
    if (r.approver_emp_no) empNos.add(r.approver_emp_no);
    if (r.temp_maintainer_emp_no) empNos.add(r.temp_maintainer_emp_no);
    if (r.emp_no) empNos.add(r.emp_no);
    if (r.equ_addr) deptNos.add(r.equ_addr);
  }
  const empMap = new Map();
  if (empNos.size > 0) {
    const empRows = await query(
      `SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${[...empNos].map((_, i) => `@e${i}`).join(',')})`,
      Object.fromEntries([...empNos].map((e, i) => [`e${i}`, e])),
    );
    for (const r of empRows) empMap.set(r.emp_no, r.emp_name || '');
  }
  const deptMap = new Map();
  if (deptNos.size > 0) {
    const deptRows = await query(
      `SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt WHERE mnt_dept_no IN (${[...deptNos].map((_, i) => `@d${i}`).join(',')})`,
      Object.fromEntries([...deptNos].map((e, i) => [`d${i}`, e])),
    );
    for (const r of deptRows) deptMap.set(r.mnt_dept_no, r.mnt_dept_name || '');
  }
  const items = rows.map((r) => {
    const maintainer = r.maintainer_emp_no || '';
    const active = r.temp_maintainer_emp_no || maintainer;
    const nextDue = r.max_mt_date
      ? addMonthsClamped(new Date(r.max_mt_date), CYCLE_MONTHS[r.maintenance_type] || 1)
      : null;
    const todayD = new Date(`${today}T00:00:00+07:00`);
    const daysOverdue = nextDue ? Math.max(0, Math.floor((todayD - nextDue) / 86400000)) : 0;
    return {
      id: r.sheet_no || r.equ_no || '',
      equNo: r.equ_no || '',
      equName: r.equ_name || '',
      equType: r.equ_type || null,
      equTypeDesc: r.equ_type_desc || null,
      factory: r.equ_addr || null,
      factoryName: deptMap.get(r.equ_addr) || null,
      maintainerEmpNo: maintainer || null,
      maintainerName: empMap.get(maintainer) || null,
      responsibleEmpNo: r.approver_emp_no || null,
      responsibleName: empMap.get(r.approver_emp_no) || null,
      activeMaintainerEmpNo: active || null,
      activeMaintainerName: empMap.get(active) || null,
      maintenanceCycle: r.maintenance_type || '1_month',
      maintenanceStatus: 'not_due',
      nextDueDate: nextDue ? nextDue.toISOString() : '',
      daysOverdue,
      completedAt: r.sheet_date ? new Date(r.sheet_date).toISOString() : null,
      sheetNo: r.sheet_no || null,
    };
  });
  return { items, total, page, pageSize, factories: [], maintTypes: [], empOptions: [], respOptions: [] };
}

module.exports = { getOverview, getDelayedStatistics, getEquipmentStatistics, getDelayHistory, listCompletedToday };
