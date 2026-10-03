const { query, withTransaction, txQuery, inClause } = require('../db');
const { assertAdmin } = require('../utils/auth');
const {
  businessToday,
  fmtDate,
  toIso,
  getNextDueDay,
  daysBetween,
  addDays,
  effectiveMaintainerEmpNo,
} = require('../utils/dates');

const REASONS = ['not_started', 'in_progress', 'awaiting_approval', 'rejected'];

function reasonForStatus(status) {
  switch (status) {
  case 'not_due':
  case 'needs_maintenance':
    return 'not_started';
  case 'in_maintenance':
    return 'in_progress';
  case 'pending_approval':
    return 'awaiting_approval';
  case 'rejected':
    return 'rejected';
  default:
    return 'not_started';
  }
}

function responsibleEmpNo(status, device) {
  switch (status) {
  case 'pending_approval':
    return device.approver_emp_no || null;
  case 'in_maintenance':
  case 'rejected':
    return effectiveMaintainerEmpNo(device);
  default:
    return device.maintainer_emp_no || null;
  }
}

// Tinh danh sach thiet bi hien dang tre han (moi thiet bi 1 reason duy nhat)
async function computeCurrentDelayed() {
  const rows = await query(
    `SELECT equ_no, equ_name, use_date, max_mt_date, maintenance_type,
            maintenance_status, maintainer_emp_no, temp_maintainer_emp_no,
            temp_maintainer_date, approver_emp_no, mnt_dept_no
     FROM eqm_mnt`,
  );
  const today = businessToday();
  const current = new Map();
  for (const row of rows) {
    const due = getNextDueDay({
      lastMaintenanceDate: row.max_mt_date,
      startDate: row.use_date,
      maintenanceCycle: row.maintenance_type,
    });
    if (!due || daysBetween(today, due) >= 0) continue;
    const status = row.maintenance_status || 'not_due';
    current.set(row.equ_no, {
      equNo: row.equ_no,
      equName: row.equ_name || null,
      reason: reasonForStatus(status),
      nextDueDate: due,
      daysOverdue: daysBetween(due, today),
      maxMtDate: row.max_mt_date ? fmtDate(row.max_mt_date) : null,
      maintenanceType: row.maintenance_type || '1_month',
      maintainerEmpNo: row.maintainer_emp_no || null,
      responsibleEmpNo: responsibleEmpNo(status, row),
      mntDeptNo: row.mnt_dept_no || null,
    });
  }
  return current;
}

// Doi soat episode trong transaction: dong episode da het tre,
// cap nhat episode con mo, mo episode moi cho thiet bi moi tre han
async function runSync() {
  const current = await computeCurrentDelayed();
  const openRows = await query(
    'SELECT id, equ_no, reason FROM eqm_mnt_delay WHERE resolved_at IS NULL',
  );

  const resolveIds = [];
  const updates = [];
  const openEquNos = new Set();
  for (const ep of openRows) {
    const cur = current.get(ep.equ_no);
    if (!cur || cur.reason !== ep.reason) {
      resolveIds.push(ep.id);
      continue;
    }
    openEquNos.add(ep.equ_no);
    updates.push({ id: ep.id, v: cur });
  }
  const inserts = [];
  for (const cur of current.values()) {
    if (!openEquNos.has(cur.equNo)) inserts.push(cur);
  }

  await withTransaction(async (tx) => {
    for (let i = 0; i < resolveIds.length; i += 300) {
      const chunk = resolveIds.slice(i, i + 300);
      const { sql: inSql, params } = inClause(chunk, 'r');
      await txQuery(
        tx,
        `UPDATE eqm_mnt_delay SET resolved_at = GETDATE() WHERE id IN (${inSql})`,
        params,
      );
    }
    for (const u of updates) {
      await txQuery(
        tx,
        `UPDATE eqm_mnt_delay
         SET equ_name = @n, reason = @r, next_due_date = @d, days_overdue = @o,
             max_mt_date = @max, maintenance_type = @t, mnt_dept_no = @dept,
             maintainer_emp_no = @m, responsible_emp_no = @resp
         WHERE id = @id`,
        {
          id: u.id,
          n: u.v.equName,
          r: u.v.reason,
          d: u.v.nextDueDate,
          o: u.v.daysOverdue,
          max: u.v.maxMtDate,
          t: u.v.maintenanceType,
          dept: u.v.mntDeptNo,
          m: u.v.maintainerEmpNo,
          resp: u.v.responsibleEmpNo,
        },
      );
    }
    const CHUNK = 300;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      const chunk = inserts.slice(i, i + CHUNK);
      const values = [];
      const params = {};
      chunk.forEach((d, idx) => {
        const p = `i${idx}_`;
        values.push(`(@${p}no, @${p}name, @${p}reason, @${p}due, @${p}over, @${p}snap, @${p}max, @${p}type, @${p}mnt, @${p}resp, @${p}dept, @${p}occ)`);
        params[`${p}no`] = d.equNo;
        params[`${p}name`] = d.equName;
        params[`${p}reason`] = d.reason;
        params[`${p}due`] = d.nextDueDate;
        params[`${p}over`] = d.daysOverdue;
        params[`${p}snap`] = new Date();
        params[`${p}occ`] = addDays(d.nextDueDate, 1);
        params[`${p}max`] = d.maxMtDate;
        params[`${p}type`] = d.maintenanceType;
        params[`${p}mnt`] = d.maintainerEmpNo;
        params[`${p}resp`] = d.responsibleEmpNo;
        params[`${p}dept`] = d.mntDeptNo;
      });
      await txQuery(
        tx,
        `INSERT INTO eqm_mnt_delay
         (equ_no, equ_name, reason, next_due_date, days_overdue, snapshot_at,
          max_mt_date, maintenance_type, maintainer_emp_no, responsible_emp_no, mnt_dept_no, occurred_at)
         VALUES ${values.join(', ')}`,
        params,
      );
    }
  });

  return { total: updates.length + inserts.length, syncedAt: new Date().toISOString() };
}

// Lich su theo bo phan: tong so lan tre (toan bo episode) + so dang tre hien tai
async function buildDeptHistory() {
  const totals = await query(
    `SELECT mnt_dept_no AS dept, COUNT(*) AS cnt
     FROM eqm_mnt_delay GROUP BY mnt_dept_no`,
  );
  const currents = await query(
    `SELECT mnt_dept_no AS dept, COUNT(*) AS cnt
     FROM eqm_mnt_delay WHERE resolved_at IS NULL GROUP BY mnt_dept_no`,
  );
  const deptCodes = totals.map((t) => t.dept).filter(Boolean);
  const nameMap = new Map();
  if (deptCodes.length > 0) {
    const { sql: inSql, params } = inClause(deptCodes, 'd');
    const deptNames = await query(
      `SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt WHERE mnt_dept_no IN (${inSql})`,
      params,
    );
    for (const d of deptNames) nameMap.set(d.mnt_dept_no, d.mnt_dept_name);
  }
  const currentMap = new Map();
  for (const c of currents) {
    if (c.dept) currentMap.set(c.dept, c.cnt);
  }
  return totals
    .filter((t) => Boolean(t.dept))
    .map((t) => ({
      departmentCode: t.dept,
      departmentName: nameMap.get(t.dept) || t.dept,
      totalEpisodes: t.cnt,
      currentDelayed: currentMap.get(t.dept) || 0,
    }))
    .sort((a, b) => b.totalEpisodes - a.totalEpisodes);
}

// Xu huong 30 ngay: moi ngay = so episode van con tre tai ngay do (open tai cuoi ngay)
async function buildDeptTrend(days = 30) {
  const rows = await query(
    'SELECT occurred_at, resolved_at, mnt_dept_no FROM eqm_mnt_delay',
  );
  const today = businessToday();
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    dates.push(new Date(todayMs - i * 86400000).toISOString().slice(0, 10));
  }
  const episodes = rows
    .filter((r) => Boolean(r.mnt_dept_no))
    .map((r) => ({
      dept: r.mnt_dept_no,
      start: toIso(r.occurred_at).slice(0, 10),
      end: r.resolved_at ? toIso(r.resolved_at).slice(0, 10) : null,
    }));
  const allDepts = await query(
    'SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt',
  );
  const nameMap = new Map(
    allDepts.map((d) => [d.mnt_dept_no, d.mnt_dept_name]),
  );
  const deptCodes = Array.from(
    new Set([
      ...allDepts.map((d) => d.mnt_dept_no),
      ...episodes.map((e) => e.dept),
    ]),
  );
  const countMap = new Map(deptCodes.map((c) => [c, dates.map(() => 0)]));
  for (const ep of episodes) {
    const counts = countMap.get(ep.dept);
    if (!counts) continue;
    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      if (ep.start <= date && (ep.end === null || ep.end > date)) {
        counts[i] += 1;
      }
    }
  }
  const series = deptCodes
    .map((code) => ({
      departmentCode: code,
      departmentName: nameMap.get(code) || code,
      counts: countMap.get(code) || [],
    }))
    .sort(
      (a, b) =>
        b.counts.reduce((s, n) => s + n, 0) - a.counts.reduce((s, n) => s + n, 0),
    );
  return { dates, series };
}

async function fetchEmpNameMap(empNos) {
  const map = new Map();
  const uniq = Array.from(new Set(empNos)).filter(Boolean);
  if (uniq.length === 0) return map;
  const { sql: inSql, params } = inClause(uniq, 'e');
  const rows = await query(
    `SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${inSql})`,
    params,
  );
  for (const r of rows) map.set(r.emp_no, r.emp_name);
  return map;
}

async function fetchDeptNameMap(deptNos) {
  const map = new Map();
  const uniq = Array.from(new Set(deptNos)).filter(Boolean);
  if (uniq.length === 0) return map;
  const { sql: inSql, params } = inClause(uniq, 'd');
  const rows = await query(
    `SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt WHERE mnt_dept_no IN (${inSql})`,
    params,
  );
  for (const r of rows) map.set(r.mnt_dept_no, r.mnt_dept_name);
  return map;
}

async function queryList(reason, page, pageSize) {
  const where = ['resolved_at IS NULL'];
  const params = { page, pageSize };
  if (reason) {
    where.push('reason = @reason');
    params.reason = reason;
  }
  const whereSql = where.join(' AND ');

  const totalRow = await query(
    `SELECT COUNT(*) AS cnt FROM eqm_mnt_delay WHERE ${whereSql}`,
    params,
  );
  const total = totalRow.length > 0 ? Number(totalRow[0].cnt) : 0;

  const lastSyncRow = await query('SELECT MAX(snapshot_at) AS t FROM eqm_mnt_delay');
  const lastSyncedAt = lastSyncRow[0] && lastSyncRow[0].t ? toIso(lastSyncRow[0].t) : null;

  const epTotalRow = await query('SELECT COUNT(*) AS cnt FROM eqm_mnt_delay');
  const totalEpisodes = epTotalRow.length > 0 ? Number(epTotalRow[0].cnt) : 0;

  const reasonCounts = REASONS.map((r) => ({ reason: r, count: 0 }));
  if (total > 0) {
    const rcRows = await query(
      `SELECT reason, COUNT(*) AS cnt FROM eqm_mnt_delay
       WHERE resolved_at IS NULL GROUP BY reason`,
    );
    for (const rc of rcRows) {
      const item = reasonCounts.find((x) => x.reason === rc.reason);
      if (item) item.count = Number(rc.cnt);
    }
  }

  const deptHistoryCounts = await buildDeptHistory();

  const today = businessToday();
  const offset = (page - 1) * pageSize;
  const rows = await query(
    `SELECT d.id, d.equ_no, d.reason, d.next_due_date, d.mnt_dept_no,
             d.maintainer_emp_no, d.snapshot_at, d.occurred_at,
             d.resolved_at, d.responsible_emp_no, d.maintenance_type,
             e.equ_name, e.max_mt_date, e.use_date,
             e.maintenance_type AS e_maintenance_type
     FROM eqm_mnt_delay d
     LEFT JOIN eqm_mnt e ON e.equ_no = d.equ_no
     WHERE ${whereSql}
     ORDER BY CASE WHEN d.resolved_at IS NULL
       THEN DATEDIFF(day, d.next_due_date, GETDATE())
       ELSE DATEDIFF(day, d.next_due_date, d.resolved_at) END DESC,
       d.equ_no ASC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { ...params, offset },
  );

  const empNos = new Set();
  const deptNos = new Set();
  const equNos = new Set();
  for (const r of rows) {
    if (r.responsible_emp_no) empNos.add(r.responsible_emp_no);
    if (r.maintainer_emp_no) empNos.add(r.maintainer_emp_no);
    if (r.mnt_dept_no) deptNos.add(r.mnt_dept_no);
    equNos.add(r.equ_no);
  }
  const [nameMap, deptMap] = await Promise.all([
    fetchEmpNameMap(Array.from(empNos)),
    fetchDeptNameMap(Array.from(deptNos)),
  ]);

  // So lan tre han lich su cua tung thiet bi trong trang hien tai
  const episodeMap = new Map();
  if (equNos.size > 0) {
    const { sql: inSql, params: eqParams } = inClause(Array.from(equNos), 'q');
    const epRows = await query(
      `SELECT equ_no, COUNT(*) AS cnt FROM eqm_mnt_delay
       WHERE equ_no IN (${inSql}) GROUP BY equ_no`,
      eqParams,
    );
    for (const ep of epRows) episodeMap.set(ep.equ_no, Number(ep.cnt));
  }

  const items = rows.map((r) => {
    const storedDue = fmtDate(r.next_due_date);
    const liveDue = r.resolved_at
      ? null
      : getNextDueDay({
        lastMaintenanceDate: r.max_mt_date,
        startDate: r.use_date,
        maintenanceCycle: r.e_maintenance_type || r.maintenance_type,
      });
    const nextDue = liveDue || storedDue;
    const endDate = r.resolved_at ? fmtDate(r.resolved_at) : today;
    const overdue = nextDue ? Math.max(0, daysBetween(nextDue, endDate)) : 0;
    return {
      id: r.id,
      deviceId: r.equ_no,
      deviceCode: r.equ_no,
      deviceName: r.equ_name || null,
      reason: r.reason,
      nextDueDate: nextDue,
      daysOverdue: overdue,
      departmentId: r.mnt_dept_no || null,
      departmentName: r.mnt_dept_no ? deptMap.get(r.mnt_dept_no) || null : null,
      maintainerId: r.maintainer_emp_no || null,
      maintainerName: r.maintainer_emp_no ? nameMap.get(r.maintainer_emp_no) || null : null,
      responsibleUserId: r.responsible_emp_no || null,
      responsibleName: r.responsible_emp_no ? nameMap.get(r.responsible_emp_no) || null : null,
      lastMaintenanceDate: r.max_mt_date ? fmtDate(r.max_mt_date) : null,
      maintenanceCycle: r.maintenance_type,
      snapshotAt: toIso(r.snapshot_at),
      episodeCount: episodeMap.get(r.equ_no) || 1,
    };
  });

  return {
    items,
    total,
    page,
    pageSize,
    reasonCounts,
    lastSyncedAt,
    totalEpisodes,
    deptHistoryCounts,
  };
}

async function adminList(req) {
  await assertAdmin(req);
  const reason = (req.query.reason || '').toString();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  return queryList(reason, page, pageSize);
}

async function adminSync(req) {
  await assertAdmin(req);
  return runSync();
}

// Lich su tre han (public, trang BI): toan bo episode ke ca da giai quyet
// days_overdue & ten thiet bi tinh/lay tu eqm_mnt luc doc, ko can sync
async function getDelayHistory(dept, page, pageSize) {
  const where = [];
  const params = { offset: (page - 1) * pageSize, pageSize };
  if (dept) {
    where.push('d.mnt_dept_no = @dept');
    params.dept = dept;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await query(
    `SELECT COUNT(*) AS cnt FROM eqm_mnt_delay d ${whereSql}`,
    params,
  );
  const total = totalRow.length > 0 ? Number(totalRow[0].cnt) : 0;

  const rows = await query(
    `SELECT d.id, d.equ_no, d.reason, d.next_due_date, d.mnt_dept_no,
            d.responsible_emp_no, d.maintenance_type, d.occurred_at, d.resolved_at,
            e.equ_name, e.max_mt_date, e.use_date,
            e.maintenance_type AS e_maintenance_type
     FROM eqm_mnt_delay d
     LEFT JOIN eqm_mnt e ON e.equ_no = d.equ_no
     ${whereSql}
     ORDER BY d.occurred_at DESC, d.id DESC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    params,
  );

  const today = businessToday();
  const empNos = new Set();
  const deptNos = new Set();
  for (const r of rows) {
    if (r.responsible_emp_no) empNos.add(r.responsible_emp_no);
    if (r.mnt_dept_no) deptNos.add(r.mnt_dept_no);
  }
  const [nameMap, deptMap] = await Promise.all([
    fetchEmpNameMap(Array.from(empNos)),
    fetchDeptNameMap(Array.from(deptNos)),
  ]);

  const items = rows.map((r) => {
    const storedDue = fmtDate(r.next_due_date);
    const liveDue = r.resolved_at
      ? null
      : getNextDueDay({
        lastMaintenanceDate: r.max_mt_date,
        startDate: r.use_date,
        maintenanceCycle: r.e_maintenance_type || r.maintenance_type,
      });
    const nextDue = liveDue || storedDue;
    const endDate = r.resolved_at ? fmtDate(r.resolved_at) : today;
    const overdue = nextDue ? Math.max(0, daysBetween(nextDue, endDate)) : 0;
    return {
      id: r.id,
      equNo: r.equ_no,
      equName: r.equ_name || null,
      departmentCode: r.mnt_dept_no || null,
      departmentName: r.mnt_dept_no ? deptMap.get(r.mnt_dept_no) || r.mnt_dept_no : null,
      cycle: r.maintenance_type || '',
      reason: r.reason,
      responsibleEmpNo: r.responsible_emp_no || null,
      responsibleName: r.responsible_emp_no ? nameMap.get(r.responsible_emp_no) || null : null,
      occurredAt: toIso(r.occurred_at),
      resolvedAt: r.resolved_at ? toIso(r.resolved_at) : null,
      nextDueDate: nextDue,
      daysOverdue: overdue,
    };
  });

  return { items, total, page, pageSize };
}

module.exports = {
  runSync,
  queryList,
  adminList,
  adminSync,
  buildDeptHistory,
  buildDeptTrend,
  getDelayHistory,
  REASONS,
};
