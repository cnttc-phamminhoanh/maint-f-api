const { query, inClause } = require('../db');
const {
  businessToday,
  getNextDueDay,
  daysBetween,
  addDays,
  effectiveStatus,
} = require('../utils/dates');
const { queryList, buildDeptHistory, buildDeptTrend, getDelayHistory } = require('./delayed.service');

const ALL_STATUSES = [
  'needs_maintenance',
  'in_maintenance',
  'pending_approval',
  'rejected',
  'not_due',
];
const ALL_CYCLES = ['1_week', '2_weeks', '1_month', '1_year'];
const ALL_REASONS = ['not_started', 'in_progress', 'awaiting_approval', 'rejected'];
const CYCLE_LABEL_MAP = {
  '1_week': '1 Week Maint',
  '2_weeks': '2 Week Maint',
  '1_month': 'Monthly Maint',
  '1_year': 'Yearly Maint',
};

async function getOverview() {
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
    const displayStatus = effectiveStatus(device, today);
    statusMap.set(displayStatus, (statusMap.get(displayStatus) || 0) + 1);

    const cycle = ALL_CYCLES.includes(row.maintenance_type) ? row.maintenance_type : '1_month';
    cycleMap.set(cycle, (cycleMap.get(cycle) || 0) + 1);

    const stat = cycleStatMap.get(cycle);
    stat.expected += 1;
    if (displayStatus === 'not_due') stat.actual += 1;
    else stat.unmaintained += 1;

    if (row.mnt_dept_no) {
      deptDeviceMap.set(row.mnt_dept_no, (deptDeviceMap.get(row.mnt_dept_no) || 0) + 1);
      const nextDue = getNextDueDay(device);
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

  const delayedReasonRows = await query(
    'SELECT reason, COUNT(*) AS count FROM eqm_mnt_delay WHERE resolved_at IS NULL GROUP BY reason',
  );
  const delayedByReason = ALL_REASONS.map((reason) => ({
    reason,
    count: (delayedReasonRows.find((r) => r.reason === reason) || {}).count || 0,
  }));
  const delayedTotal = delayedByReason.reduce((sum, r) => sum + r.count, 0);

  const delayedDeptRows = await query(
    'SELECT mnt_dept_no AS dept, COUNT(*) AS count FROM eqm_mnt_delay WHERE resolved_at IS NULL GROUP BY mnt_dept_no',
  );
  const deptDelayedMap = new Map();
  for (const r of delayedDeptRows) {
    if (r.dept) deptDelayedMap.set(r.dept, r.count);
  }

  const deptCodes = [...new Set([...deptDeviceMap.keys(), ...deptDelayedMap.keys()])];
  const deptNameMap = new Map();
  if (deptCodes.length > 0) {
    const { sql: inSql, params } = inClause(deptCodes, 'd');
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
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRows = await query(`SELECT COUNT(*) AS total FROM eqm_mnt ${whereSql}`, values);
  const total = totalRows[0] ? totalRows[0].total : 0;

  values.offset = (params.page - 1) * params.pageSize;
  values.pageSize = params.pageSize;
  const rows = await query(
    `SELECT id, equ_no, equ_name, equ_type, equ_type_desc, equ_addr,
      maintainer_emp_no, approver_emp_no, temp_maintainer_emp_no,
      maintenance_type, maintenance_status, use_date, max_mt_date, mnt_dept_no
     FROM eqm_mnt ${whereSql}
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
    const { sql: inSql, params } = inClause(empNos, 'e');
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
    const nextDue = getNextDueDay(device);
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

module.exports = { getOverview, getDelayedStatistics, getEquipmentStatistics, getDelayHistory };
