const { query, withTransaction, txQuery, inClause } = require('../db');
//const { ApiError } = require('../errors');
const { assertAdmin, getCaller } = require('../utils/auth');
const {
  businessToday,
  fmtDate,
  toIso,
  getNextDueDay,
  daysBetween,
  effectiveMaintainerEmpNo,
} = require('../utils/dates');

const REASONS = ['not_started', 'in_progress', 'awaiting_approval', 'rejected'];

function reasonForStatus(status) {
  if (status === 'in_maintenance') return 'in_progress';
  if (status === 'pending_approval') return 'awaiting_approval';
  if (status === 'rejected') return 'rejected';
  return 'not_started';
}

function responsibleEmpNo(row, reason, today) {
  if (reason === 'awaiting_approval') return row.approver_emp_no || null;
  if (reason === 'in_progress' || reason === 'rejected') {
    return effectiveMaintainerEmpNo(row, today);
  }
  return row.maintainer_emp_no || null;
}

// Tinh toan lai toan bo bang anh thiet bi tre han (delete + insert trong transaction)
async function runSync() {
  const rows = await query(
    `SELECT equ_no, equ_name, use_date, max_mt_date, maintenance_type, maintenance_status,
      maintainer_emp_no, approver_emp_no, temp_maintainer_emp_no, temp_maintainer_date, mnt_dept_no
     FROM eqm_mnt`,
  );
  const today = businessToday();
  const values = [];
  for (const row of rows) {
    const nextDue = getNextDueDay({
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
    });
    if (!nextDue || nextDue >= today) continue;
    const daysOverdue = Math.abs(daysBetween(nextDue, today));
    const reason = reasonForStatus(row.maintenance_status);
    values.push({
      equNo: row.equ_no,
      equName: row.equ_name || '',
      reason,
      nextDueDate: nextDue,
      daysOverdue,
      mntDeptNo: row.mnt_dept_no || null,
      maintainerEmpNo: row.maintainer_emp_no || null,
      responsibleEmpNo: responsibleEmpNo(row, reason, today),
      maxMtDate: fmtDate(row.max_mt_date),
      maintenanceType: row.maintenance_type || '1_month',
    });
  }

  await withTransaction(async (tx) => {
    await txQuery(tx, 'DELETE FROM eqm_mnt_delay');
    const CHUNK = 150; // 10 cot x 150 dong = 1500 tham so (< gioi han 2100 cua SQL Server)
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      const paramNames = [];
      const params = {};
      chunk.forEach((v, idx) => {
        const p = (name, val) => {
          const key = `p${idx}_${name}`;
          params[key] = val;
          return `@${key}`;
        };
        paramNames.push(
          `(${p('equNo', v.equNo)}, ${p('equName', v.equName)}, ${p('reason', v.reason)},
            ${p('nextDue', v.nextDueDate)}, ${p('days', v.daysOverdue)}, ${p('dept', v.mntDeptNo)},
            ${p('mnt', v.maintainerEmpNo)}, ${p('resp', v.responsibleEmpNo)},
            ${p('maxMt', v.maxMtDate)}, ${p('type', v.maintenanceType)})`,
        );
      });
      await txQuery(
        tx,
        `INSERT INTO eqm_mnt_delay (equ_no, equ_name, reason, next_due_date, days_overdue,
          mnt_dept_no, maintainer_emp_no, responsible_emp_no, max_mt_date, maintenance_type)
         VALUES ${paramNames.join(', ')}`,
        params,
      );
    }
  });
  return { total: values.length, syncedAt: new Date().toISOString() };
}

async function queryList(reason, page, pageSize) {
  const reasonCounts = { not_started: 0, in_progress: 0, awaiting_approval: 0, rejected: 0 };
  const groupRows = await query('SELECT reason, COUNT(*) AS count FROM eqm_mnt_delay GROUP BY reason');
  for (const row of groupRows) {
    if (REASONS.includes(row.reason)) reasonCounts[row.reason] = row.count;
  }

  const where = reason ? 'WHERE reason = @reason' : '';
  const values = reason ? { reason } : {};
  const totalRows = await query(`SELECT COUNT(*) AS total FROM eqm_mnt_delay ${where}`, values);
  const total = totalRows[0] ? totalRows[0].total : 0;

  values.offset = (page - 1) * pageSize;
  values.pageSize = pageSize;
  const rows = await query(
    `SELECT * FROM eqm_mnt_delay ${where}
     ORDER BY days_overdue DESC, equ_no ASC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    values,
  );

  const lastRows = await query('SELECT MAX(snapshot_at) AS last FROM eqm_mnt_delay');
  const lastSyncedAt = toIso(lastRows[0] && lastRows[0].last) || null;

  const empNos = [...new Set(rows.flatMap((r) => [r.maintainer_emp_no, r.responsible_emp_no]).filter(Boolean))];
  const deptNos = [...new Set(rows.map((r) => r.mnt_dept_no).filter(Boolean))];
  const empMap = new Map();
  const deptMap = new Map();
  if (empNos.length > 0) {
    const { sql: inSql, params } = inClause(empNos, 'e');
    const empRows = await query(`SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${inSql})`, params);
    for (const r of empRows) empMap.set(r.emp_no, r.emp_name || '');
  }
  if (deptNos.length > 0) {
    const { sql: inSql, params } = inClause(deptNos, 'd');
    const deptRows = await query(
      `SELECT mnt_dept_no, mnt_dept_name FROM dept_mnt WHERE mnt_dept_no IN (${inSql})`,
      params,
    );
    for (const r of deptRows) deptMap.set(r.mnt_dept_no, r.mnt_dept_name || '');
  }

  const items = rows.map((row) => ({
    id: row.id,
    deviceId: row.equ_no,
    deviceCode: row.equ_no,
    deviceName: row.equ_name || '',
    reason: row.reason,
    nextDueDate: fmtDate(row.next_due_date),
    daysOverdue: row.days_overdue,
    lastMaintenanceDate: fmtDate(row.max_mt_date),
    maintenanceCycle: row.maintenance_type,
    departmentId: row.mnt_dept_no || '',
    departmentName: deptMap.get(row.mnt_dept_no) || null,
    maintainerId: row.maintainer_emp_no || '',
    maintainerName: empMap.get(row.maintainer_emp_no) || null,
    responsibleUserId: row.responsible_emp_no || '',
    responsibleName: empMap.get(row.responsible_emp_no) || null,
    snapshotAt: toIso(row.snapshot_at),
  }));
  return {
    items,
    total,
    page,
    pageSize,
    reasonCounts: REASONS.map((r) => ({ reason: r, count: reasonCounts[r] })),
    lastSyncedAt,
  };
}

// Chi admin moi duoc xem danh sach thiet bi tre han
async function adminList(userId, reason, page, pageSize) {
  const caller = await getCaller(userId);
  assertAdmin(caller.position);
  return queryList(reason, page, pageSize);
}

async function adminSync(userId) {
  const caller = await getCaller(userId);
  assertAdmin(caller.position);
  return runSync();
}

module.exports = { runSync, queryList, adminList, adminSync, REASONS };
