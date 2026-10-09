const { query, withTransaction, txQuery, inClause } = require('../db');
const holidayService = require('./holiday.service');
const { assertAdmin, getCaller } = require('../utils/auth');
const {
  businessToday,
  fmtDate,
  toIso,
  hkDateStr,
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

// Episode do (nhan vien) cua thiet bi dang cho duyet = "treo": van mo trong DB
// nhung an khoi moi view cho den khi duyet (dong) hoac tu choi (tiep tuc). 2026-10-09.
// Episode awaiting_approval (trach nhiem nguoi duyet) thi VAN HIEN THI binh thuong
// o tat ca view quan tri (BI/admin/lich su) khi qua an han.
const SUSPENDED_EPISODE_SQL = `NOT (
  d.resolved_at IS NULL
  AND d.reason <> 'awaiting_approval'
  AND EXISTS (
    SELECT 1 FROM eqm_mnt m
    WHERE m.equ_no = d.equ_no
      AND m.maintenance_status = 'pending_approval'))`;

function responsibleForReason(reason, device) {
  if (reason === 'not_started') return device.maintainer_emp_no || null;
  return effectiveMaintainerEmpNo(device);
}

// Moi thiet bi qua han = 1 entry day du cho runSync (2026-10-09):
// - pending_approval: episode do (employee) "treo" (ko dong/ko cap nhat/an view);
//   episode vang (awaiting) chi mo khi qua an han = awaitingStart.
// - khac: episode do hoat dong binh thuong voi employeeReason.
async function computeCurrentDelayed() {
  await holidayService.ensureHolidaysLoaded();
  const rows = await query(
    `SELECT equ_no, equ_name, use_date, max_mt_date, maintenance_type,
            maintenance_status, maintainer_emp_no, temp_maintainer_emp_no,
            temp_maintainer_date, approver_emp_no, mnt_dept_no,
            completion_requested_at
     FROM eqm_mnt`,
  );
  const today = businessToday();
  const current = new Map();
  for (const row of rows) {
    const due = holidayService.getAdjustedDueDay({
      lastMaintenanceDate: row.max_mt_date,
      startDate: row.use_date,
      maintenanceCycle: row.maintenance_type,
    });
    if (!due || daysBetween(today, due) >= 0) continue;
    const status = row.maintenance_status || 'not_due';
    const pending = status === 'pending_approval';
    let awaitingStart = null;
    if (pending) {
      // An han cho duyet: nguoi duyet co them 1 ngay lam viec ke tu ngay muon hon
      // giua (han, ngay gui xet duyet), nhay qua Chu nhat + ngay le hr_holiday.
      const submitDay = hkDateStr(row.completion_requested_at);
      const anchor = submitDay && submitDay > due ? submitDay : due;
      const graceEnd = holidayService.shiftPastHolidays(addDays(anchor, 1));
      if (daysBetween(today, graceEnd) < 0) awaitingStart = addDays(graceEnd, 1);
    }
    const employeeReason = pending ? null : reasonForStatus(status);
    current.set(row.equ_no, {
      equNo: row.equ_no,
      equName: row.equ_name || null,
      nextDueDate: due,
      daysOverdue: daysBetween(due, today),
      maxMtDate: row.max_mt_date ? fmtDate(row.max_mt_date) : null,
      maintenanceType: row.maintenance_type || '1_month',
      maintainerEmpNo: row.maintainer_emp_no || null,
      mntDeptNo: row.mnt_dept_no || null,
      pending,
      employeeReason,
      employeeResponsible: employeeReason
        ? responsibleForReason(employeeReason, row)
        : null,
      approverResponsible: row.approver_emp_no || null,
      awaitingStart,
      employeeOccurredAt: addDays(due, 1),
    });
  }
  return current;
}

// Doi soat episode trong transaction (2026-10-09):
// - thiet bi pending: episode do giu "treo" (ko dong/ko cap nhat); episode vang
//   chi mo/cap nhat khi qua an han (awaitingStart); chua qua an han ma con dong
//   vang thi dong (chot cac dong ghi som truoc 10-09).
// - thiet bi khac pending: episode vang dong; episode do cap nhat tai cho
//   (doi reason not_started/in_progress/rejected, giu occurred_at = lien mach);
//   chua co thi mo moi.
// - thiet bi het tre han: dong moi episode con mo.
async function runSync() {
  const current = await computeCurrentDelayed();
  const openRows = await query(
    'SELECT id, equ_no, reason FROM eqm_mnt_delay WHERE resolved_at IS NULL',
  );
  const openByEqu = new Map();
  for (const ep of openRows) {
    const slot = openByEqu.get(ep.equ_no) || {};
    if (ep.reason === 'awaiting_approval') slot.awaiting = ep;
    else slot.emp = ep;
    openByEqu.set(ep.equ_no, slot);
  }

  const resolveIds = [];
  const empUpdates = [];
  const awUpdates = [];
  const inserts = [];
  for (const cur of current.values()) {
    const slot = openByEqu.get(cur.equNo) || {};
    if (cur.pending) {
      if (cur.awaitingStart) {
        if (slot.awaiting) awUpdates.push({ id: slot.awaiting.id, v: cur });
        else {
          inserts.push(
            buildRow(cur, 'awaiting_approval', cur.awaitingStart, cur.approverResponsible),
          );
        }
      } else if (slot.awaiting) {
        resolveIds.push(slot.awaiting.id);
      }
    } else {
      if (slot.awaiting) resolveIds.push(slot.awaiting.id);
      if (slot.emp) empUpdates.push({ id: slot.emp.id, v: cur });
      else {
        inserts.push(
          buildRow(cur, cur.employeeReason, cur.employeeOccurredAt, cur.employeeResponsible),
        );
      }
    }
  }
  for (const ep of openRows) {
    if (!current.has(ep.equ_no)) resolveIds.push(ep.id);
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
    for (const u of empUpdates) {
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
          r: u.v.employeeReason,
          d: u.v.nextDueDate,
          o: u.v.daysOverdue,
          max: u.v.maxMtDate,
          t: u.v.maintenanceType,
          dept: u.v.mntDeptNo,
          m: u.v.maintainerEmpNo,
          resp: u.v.employeeResponsible,
        },
      );
    }
    for (const u of awUpdates) {
      await txQuery(
        tx,
        `UPDATE eqm_mnt_delay
         SET equ_name = @n, next_due_date = @d, days_overdue = @o,
             max_mt_date = @max, maintenance_type = @t, mnt_dept_no = @dept,
             maintainer_emp_no = @m, responsible_emp_no = @resp, occurred_at = @occ
         WHERE id = @id`,
        {
          id: u.id,
          n: u.v.equName,
          d: u.v.nextDueDate,
          o: u.v.daysOverdue,
          max: u.v.maxMtDate,
          t: u.v.maintenanceType,
          dept: u.v.mntDeptNo,
          m: u.v.maintainerEmpNo,
          resp: u.v.approverResponsible,
          occ: u.v.awaitingStart,
        },
      );
    }
    // 12 param/dong -> CHUNK 150 = 1800 param, duoi gioi han 2100 cua SQL Server
    const CHUNK = 150;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      const chunk = inserts.slice(i, i + CHUNK);
      const values = [];
      const params = {};
      chunk.forEach((d, idx) => {
        const p = `i${idx}_`;
        values.push(`(@${p}no, @${p}name, @${p}reason, @${p}due, @${p}over, GETDATE(), @${p}max, @${p}type, @${p}mnt, @${p}resp, @${p}dept, @${p}occ)`);
        params[`${p}no`] = d.equNo;
        params[`${p}name`] = d.equName;
        params[`${p}reason`] = d.reason;
        params[`${p}due`] = d.nextDueDate;
        params[`${p}over`] = d.daysOverdue;
        params[`${p}occ`] = d.occurredAt;
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

  return {
    total: empUpdates.length + awUpdates.length + inserts.length,
    syncedAt: new Date().toISOString(),
  };
}

function buildRow(cur, reason, occurredAt, responsibleEmpNo) {
  return {
    equNo: cur.equNo,
    equName: cur.equName,
    nextDueDate: cur.nextDueDate,
    daysOverdue: cur.daysOverdue,
    maxMtDate: cur.maxMtDate,
    maintenanceType: cur.maintenanceType,
    maintainerEmpNo: cur.maintainerEmpNo,
    mntDeptNo: cur.mntDeptNo,
    reason,
    occurredAt,
    responsibleEmpNo,
  };
}

// Lich su theo bo phan: tong so lan tre (toan bo episode) + so dang tre hien tai
async function buildDeptHistory() {
  const totals = await query(
    `SELECT mnt_dept_no AS dept, COUNT(*) AS cnt
     FROM eqm_mnt_delay GROUP BY mnt_dept_no`,
  );
  const currents = await query(
    `SELECT mnt_dept_no AS dept, COUNT(*) AS cnt
     FROM eqm_mnt_delay d
     WHERE d.resolved_at IS NULL AND ${SUSPENDED_EPISODE_SQL}
     GROUP BY mnt_dept_no`,
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
    `SELECT occurred_at, resolved_at, mnt_dept_no FROM eqm_mnt_delay d
     WHERE ${SUSPENDED_EPISODE_SQL}`,
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
      start: hkDateStr(r.occurred_at),
      end: r.resolved_at ? hkDateStr(r.resolved_at) : null,
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
  await holidayService.ensureHolidaysLoaded();
  // Cho duyet: episode vang chi sau an han; episode do cua thiet bi pending = treo (an)
  const where = ['d.resolved_at IS NULL', SUSPENDED_EPISODE_SQL];
  const params = { page, pageSize };
  if (reason) {
    where.push('reason = @reason');
    params.reason = reason;
  }
  const whereSql = where.join(' AND ');

  const totalRow = await query(
    `SELECT COUNT(*) AS cnt FROM eqm_mnt_delay d WHERE ${whereSql}`,
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
      `SELECT reason, COUNT(*) AS cnt FROM eqm_mnt_delay d
     WHERE d.resolved_at IS NULL AND ${SUSPENDED_EPISODE_SQL}
     GROUP BY reason`,
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
       THEN DATEDIFF(day, d.next_due_date, CAST(@today AS date))
       ELSE DATEDIFF(day, d.next_due_date, d.resolved_at) END DESC,
       d.equ_no ASC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { ...params, offset, today },
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
      : holidayService.getAdjustedDueDay({
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

// Route truyen (userId, reason, page, pageSize) — assertAdmin nhan chuoi position,
// truoc 2026-10-06 truyen nham doi so khien moi ke ca admin deu bi 403 'not admin'
async function adminList(userId, reason, page, pageSize) {
  const caller = await getCaller(userId);
  assertAdmin(caller.position);
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safePageSize = Math.min(50, Math.max(1, parseInt(String(pageSize), 10) || 30));
  return queryList((reason || '').toString(), safePage, safePageSize);
}

async function adminSync(userId) {
  const caller = await getCaller(userId);
  assertAdmin(caller.position);
  return runSync();
}

// Lich su tre han (public, trang BI): toan bo episode ke ca da giai quyet
// days_overdue & ten thiet bi tinh/lay tu eqm_mnt luc doc, ko can sync
async function getDelayHistory(dept, page, pageSize) {
  await holidayService.ensureHolidaysLoaded();
  const where = [SUSPENDED_EPISODE_SQL];
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
            d.snapshot_at,
            d.equ_name, d.max_mt_date, e.use_date,
            d.maintenance_type AS e_maintenance_type
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
      : holidayService.getAdjustedDueDay({
        lastMaintenanceDate: r.max_mt_date,
        startDate: r.use_date,
        maintenanceCycle: r.e_maintenance_type || r.maintenance_type,
      });
    const nextDue = liveDue || storedDue;
    const endDate = r.resolved_at ? fmtDate(r.resolved_at) : today;
    const overdue = nextDue ? Math.max(0, daysBetween(nextDue, endDate)) : 0;
    return {
      id: String(r.id),
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
      snapshotAt: toIso(r.snapshot_at),
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
  SUSPENDED_EPISODE_SQL,
};
