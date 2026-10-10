const { query, queryOne, withTransaction, txQuery, inClause } = require('../db');
const { ApiError } = require('../errors');
const workshopService = require('./workshop.service');
const config = require('../config');
const {
  MAINTAINER_POSITIONS,
  isDeptManagerPosition,
  resolveUser,
  getCaller,
} = require('../utils/auth');
const {
  businessToday,
  fmtDate,
  toIso,
  addDays,
  getNextDueDay,
  effectiveStatus,
  isTempActive,
  effectiveMaintainerEmpNo,
} = require('../utils/dates');
const { resolveSelectedTemplates, cycleToMtFlag } = require('./maintenance-order.service');
const holidayService = require('./holiday.service');

// bieu thuc SQL tinh ngay den han (DATEADD tu clamp ngay cuoi thang - FIX #1).
// 2026-10-07: boc them fn_shift_due de doi ngay han qua ngay nghi (chu nhat + hr_holiday)
// khi function da duoc tao (sql/003_hr_holiday.sql).
const NEXT_DUE_BASE_SQL = `CAST(CASE
  WHEN d.maintenance_type = '1_week' THEN DATEADD(day, 7, ISNULL(d.max_mt_date, d.use_date))
  WHEN d.maintenance_type IN ('2_weeks','2_week') THEN DATEADD(day, 14, ISNULL(d.max_mt_date, d.use_date))
  WHEN d.maintenance_type = '1_month' THEN DATEADD(month, 1, ISNULL(d.max_mt_date, d.use_date))
  WHEN d.maintenance_type = '1_year' THEN DATEADD(year, 1, ISNULL(d.max_mt_date, d.use_date))
  ELSE DATEADD(month, 1, ISNULL(d.max_mt_date, d.use_date))
END AS date)`;

function nextDueSql() {
  return holidayService.holidaySqlEnabled()
    ? `dbo.fn_shift_due(${NEXT_DUE_BASE_SQL})`
    : NEXT_DUE_BASE_SQL;
}

const DEVICE_SELECT = `d.id, d.equ_no, d.equ_name, d.use_date, d.max_mt_date,
  d.maintenance_type, d.maintenance_status, d.completion_requested_at, d.rejection_reason,
  d.maintainer_emp_no, d.approver_emp_no, d.temp_maintainer_emp_no, d.temp_maintainer_date,
  d.equ_addr, d.equ_dept_no, d.equ_type, d.equ_type_desc, d.mnt_dept_no, d.pending_maintenance_items,
  COALESCE(b1.dept_name, b2.dept_name) AS equ_addr_name`;

// 2026-10-10: vi tri thiet bi = ten phong ban trong bas_dept;
// uu tien equ_addr, khong khop thi fallback equ_dept_no (user da check SELECT nay)
const DEVICE_FROM = `FROM eqm_mnt d
  LEFT JOIN dbo.bas_dept b1 ON b1.dept_no = d.equ_addr
  LEFT JOIN dbo.bas_dept b2 ON b2.dept_no = d.equ_dept_no`;

const EMPTY_COUNTS = {
  dueCounts: { all: 0, overdue: 0, today: 0, tomorrow: 0, later: 0 },
  statusCounts: {
    all: 0,
    needs_maintenance: 0,
    in_maintenance: 0,
    pending_approval: 0,
    rejected: 0,
    not_due: 0,
  },
  cycleCounts: { all: 0, '1_week': 0, '2_weeks': 0, '1_month': 0, '1_year': 0 },
};

const STATUS_ENUM = ['needs_maintenance', 'in_maintenance', 'pending_approval', 'not_due'];

// Vi tri duoc thay dong "Nguoi phu trach" tren card (giong cloud FE)
const SHOW_MAINTAINER_POSITIONS = ['admin', 'chu_quan', 'nhan_vien_bao_tri', 'van_thu'];
// Vi tri co trang chu la danh sach thiet bi phong ban (FE luon goi scope=department)
const DEPT_HOME_POSITIONS = ['nhan_vien_bao_tri', 'chu_quan', 'van_thu'];

function touchSuffix() {
  return config.updatedAtCol ? `, ${config.updatedAtCol} = GETDATE()` : '';
}

function orderByDeviceList(_today) {
  const parts = [
    `CASE
      WHEN d.maintenance_status = 'in_maintenance' THEN 1
      WHEN d.maintenance_status = 'pending_approval' THEN 2
      WHEN d.maintenance_status = 'rejected' THEN 3
      WHEN ${nextDueSql()} <= @today THEN 4
      ELSE 5
    END ASC`,
  ];
  if (config.updatedAtCol) {
    parts.push(
      `CASE WHEN d.maintenance_status = 'in_maintenance' THEN d.${config.updatedAtCol} END DESC`,
    );
  }
  parts.push(`${nextDueSql()} ASC`, 'd.equ_no ASC');
  return parts.join(', ');
}

async function getEmpNameMap(empNos) {
  const unique = [...new Set(empNos.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;
  const { sql: inSql, params } = inClause(unique, 'e');
  const rows = await query(
    `SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${inSql})`,
    params,
  );
  for (const row of rows) map.set(row.emp_no, row.emp_name || '');
  return map;
}

function toDeviceRecord(row, empNameMap, today, xuongMap) {
  const effectiveId = effectiveMaintainerEmpNo(row, today);
  const maintainerId = row.maintainer_emp_no || '';
  // 2026-10-09: approver_emp_no = ma phan xuong; Nguoi quan ly = chu quan xuong.
  // Chua co du lieu xuong_mnt thi fallback ve gia tri cu (MNV)
  const managerCode = row.approver_emp_no || '';
  const xuong = managerCode && xuongMap ? xuongMap.get(managerCode) : undefined;
  const managerId = xuong ? (xuong.headEmpNo || '') : managerCode;
  const adjustedDue = holidayService.shiftPastHolidays(
    getNextDueDay({
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
    }),
  );
  const status = effectiveStatus(
    {
      maintenanceStatus: row.maintenance_status,
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
    },
    today,
    adjustedDue,
  );
  const showMaintenanceBy = ['in_maintenance', 'pending_approval', 'rejected'].includes(status);
  return {
    // SQL Server tra id kieu int -> ep string dung hop đồng DeviceRecord.id,
    // tranh FE gui lai ids so bi Joi.string() tu choi (400 bulk-approve 2026-10-06)
    id: String(row.id),
    code: row.equ_no,
    name: row.equ_name,
    startDate: fmtDate(row.use_date),
    lastMaintenanceDate: fmtDate(row.max_mt_date),
    maintenanceCycle: row.maintenance_type,
    maintainer: maintainerId
      ? { userId: maintainerId, empNo: maintainerId, empName: empNameMap.get(maintainerId) || '' }
      : null,
    manager: managerId
      ? { userId: managerId, empNo: managerId, empName: empNameMap.get(managerId) || '' }
      : null,
    requestedAt: toIso(row.completion_requested_at),
    maintenanceStatus: status,
    maintenanceBy:
      showMaintenanceBy && effectiveId
        ? { userId: effectiveId, empNo: effectiveId, empName: empNameMap.get(effectiveId) || '' }
        : null,
    isTemporaryHandover: isTempActive(row, today),
    rejectionReason: row.rejection_reason || '',
    factory: row.equ_addr || '',
    factoryName: row.equ_addr_name || '',
    equType: row.equ_type || '',
    equTypeDesc: row.equ_type_desc || '',
  };
}

async function enrichRecords(rows, today) {
  await holidayService.ensureHolidaysLoaded();
  const xuongCodes = [...new Set(rows.map((row) => row.approver_emp_no).filter(Boolean))];
  const xuongMap = await workshopService.getXuongHeadMap(xuongCodes);
  const empNos = [];
  for (const row of rows) {
    const effective = effectiveMaintainerEmpNo(row, today);
    if (effective) empNos.push(effective);
    if (row.maintainer_emp_no) empNos.push(row.maintainer_emp_no);
  }
  for (const info of xuongMap.values()) {
    if (info.headEmpNo) empNos.push(info.headEmpNo);
  }
  const map = await getEmpNameMap(empNos);
  return rows.map((row) => toDeviceRecord(row, map, today, xuongMap));
}

function assertCanMaintain(caller, row, today) {
  if (caller.position === 'admin') return;
  const isMaintainer = effectiveMaintainerEmpNo(row, today) === caller.empNo;
  const sameDept = caller.departmentId !== null && row.mnt_dept_no === caller.departmentId;
  if ((MAINTAINER_POSITIONS.includes(caller.position) || caller.position === 'van_thu') && sameDept) {
    return;
  }
  if (isMaintainer) return;
  throw new ApiError(403, 'not allowed');
}

async function getDeviceRow(id) {
  if (!/^\d+$/.test(String(id))) return null;
  return queryOne(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.id = @id`, { id });
}

async function getDeviceById(id) {
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const today = businessToday();
  const [record] = await enrichRecords([row], today);
  return record;
}

// ==== Danh sach thiet bi ====

// 2026-10-09: duyet theo bo phan — chu quan / van thu duoc duyet thiet bi
// cho duyet trong dung bo phan cua minh, chay song song voi thanh vien phan xuong
function isDeptApprovalAllowed(requester, row) {
  return (
    isDeptManagerPosition(requester.position || '') &&
    !!requester.mnt_dept_no &&
    row.mnt_dept_no === requester.mnt_dept_no
  );
}

async function buildScopeCondition(params, caller, values, _today) {
  // 2026-10-09: thiet bi can duyet = pending_approval cua
  // (a) bo phan minh (chu quan / van thu) hoac (b) phan xuong minh la thanh vien
  if (params.approvalOnly) {
    const canDeptApprove =
      isDeptManagerPosition(caller.position) && !!caller.departmentId;
    const xuongNos = await workshopService.getMemberXuongNos(caller.empNo);
    if (!canDeptApprove && xuongNos.length === 0) return null;
    const orParts = [];
    if (canDeptApprove) {
      values.callerDept = caller.departmentId;
      orParts.push('d.mnt_dept_no = @callerDept');
    }
    if (xuongNos.length > 0) {
      const { sql, params: xParams } = inClause(xuongNos, 'x');
      Object.assign(values, xParams);
      orParts.push(`d.approver_emp_no IN (${sql})`);
    }
    return [
      'd.maintenance_status = \'pending_approval\'',
      `(${orParts.join(' OR ')})`,
    ];
  }
  if (params.scope === 'mine') {
    values.callerEmpNo = caller.empNo;
    return ['d.maintainer_emp_no = @callerEmpNo'];
  }
  // Khong truyen scope: dung tam nhin trang chu cua FE —
  // nhan vien/chu quan/van thu thay toan bo thiet bi phong ban minh
  const isDeptScope =
    params.scope === 'department' ||
    (!params.scope && DEPT_HOME_POSITIONS.includes(caller.position));
  if (isDeptScope) {
    if (caller.position === 'admin') return [];
    if (!caller.departmentId) return null; // khong co phong ban -> trong
    values.callerDept = caller.departmentId;
    return ['d.mnt_dept_no = @callerDept'];
  }
  switch (caller.position) {
  case 'admin':
    return [];
  case 'approver': {
    const xuongNos = await workshopService.getMemberXuongNos(caller.empNo);
    if (xuongNos.length === 0) return ['1 = 0'];
    const { sql, params: xParams } = inClause(xuongNos, 'x');
    Object.assign(values, xParams);
    return [`d.maintenance_status = 'pending_approval' AND d.approver_emp_no IN (${sql})`];
  }
  case 'chu_quan':
  case 'van_thu': {
    const parts = [];
    if (caller.departmentId) {
      values.callerDept = caller.departmentId;
      parts.push('d.mnt_dept_no = @callerDept');
    }
    values.callerEmpNo = caller.empNo;
    parts.push('d.maintainer_emp_no = @callerEmpNo');
    // temp khong het han qua ngay: thiet bi da tiep quan van thuoc ve nguoi quet ma
    parts.push('d.temp_maintainer_emp_no = @callerEmpNo');
    return [`(${parts.join(' OR ')})`];
  }
  case 'nhan_vien_bao_tri':
    values.callerEmpNo = caller.empNo;
    // temp khong het han qua ngay: thiet bi cua minh = minh phu trach va chua ai tiep quan,
    // hoac minh da tiep quan (bat ke ngay nao)
    return [
      `((d.maintainer_emp_no = @callerEmpNo
           AND (d.temp_maintainer_emp_no IS NULL OR d.temp_maintainer_emp_no = @callerEmpNo))
         OR d.temp_maintainer_emp_no = @callerEmpNo)`,
    ];
  default:
    return ['1 = 0'];
  }
}

async function listDevices(params) {
  const caller = await getCaller(params.userId);
  const today = businessToday();
  const values = { today, tomorrow: addDays(today, 1) };

  const scopeCond = await buildScopeCondition(params, caller, values, today);
  if (scopeCond === null) {
    return {
      items: [],
      position: caller.position,
      showMaintainer: SHOW_MAINTAINER_POSITIONS.includes(caller.position),
      total: 0,
      page: params.page,
      pageSize: params.pageSize,
      ...EMPTY_COUNTS,
    };
  }
  const cond = [...scopeCond];
  let needJoin = false;

  if (params.search) {
    values.q = `%${params.search}%`;
    const parts = ['d.equ_no LIKE @q', 'd.equ_name LIKE @q'];
    if (caller.position === 'admin') {
      parts.push('m2.emp_name LIKE @q');
      needJoin = true;
    } else if (isDeptManagerPosition(caller.position) && caller.departmentId) {
      values.callerDept = caller.departmentId;
      parts.push('(d.mnt_dept_no = @callerDept AND m2.emp_name LIKE @q)');
      needJoin = true;
    }
    cond.push(`(${parts.join(' OR ')})`);
  }

  const joinSql = needJoin ? 'LEFT JOIN emp_mnt m2 ON m2.emp_no = d.maintainer_emp_no' : '';
  const baseWhere = cond.length > 0 ? `WHERE ${cond.join(' AND ')}` : '';

  // dem theo thoi han + trang thai + chu ky (tinh tren dieu kien goc, chua loc status/due/cycle)
  const countRows = await query(
    `SELECT COUNT(*) AS total,
      ISNULL(SUM(CASE WHEN ${nextDueSql()} < @today AND d.maintenance_status <> 'pending_approval' THEN 1 ELSE 0 END), 0) AS overdue,
      ISNULL(SUM(CASE WHEN ${nextDueSql()} = @today THEN 1 ELSE 0 END), 0) AS dueToday,
      ISNULL(SUM(CASE WHEN ${nextDueSql()} = @tomorrow THEN 1 ELSE 0 END), 0) AS dueTomorrow,
      ISNULL(SUM(CASE WHEN ${nextDueSql()} > @tomorrow THEN 1 ELSE 0 END), 0) AS dueLater,
      ISNULL(SUM(CASE WHEN d.maintenance_status IN ('needs_maintenance','not_due')
          AND ${nextDueSql()} <= @today THEN 1 ELSE 0 END), 0) AS stNeeds,
      ISNULL(SUM(CASE WHEN d.maintenance_status = 'in_maintenance' THEN 1 ELSE 0 END), 0) AS stInMaint,
      ISNULL(SUM(CASE WHEN d.maintenance_status = 'pending_approval' THEN 1 ELSE 0 END), 0) AS stPending,
      ISNULL(SUM(CASE WHEN d.maintenance_status = 'rejected' THEN 1 ELSE 0 END), 0) AS stRejected,
      ISNULL(SUM(CASE WHEN d.maintenance_status IN ('needs_maintenance','not_due')
          AND ${nextDueSql()} > @today THEN 1 ELSE 0 END), 0) AS stNotDue,
      ISNULL(SUM(CASE WHEN d.maintenance_type = '1_week' THEN 1 ELSE 0 END), 0) AS cy1w,
      ISNULL(SUM(CASE WHEN d.maintenance_type IN ('2_weeks','2_week') THEN 1 ELSE 0 END), 0) AS cy2w,
      ISNULL(SUM(CASE WHEN d.maintenance_type = '1_month' THEN 1 ELSE 0 END), 0) AS cy1m,
      ISNULL(SUM(CASE WHEN d.maintenance_type = '1_year' THEN 1 ELSE 0 END), 0) AS cy1y
    FROM eqm_mnt d ${joinSql} ${baseWhere}`,
    values,
  );
  const c = countRows[0];

  // them loc status / cycle / due
  const finalCond = [...cond];
  if (params.status) {
    // 2026-10-10: status filter phai dung chuan effectiveStatus giong card hien thi
    if (params.status === 'needs_maintenance') {
      finalCond.push(`d.maintenance_status IN ('needs_maintenance','not_due') AND ${nextDueSql()} <= @today`);
    } else if (params.status === 'not_due') {
      finalCond.push(`d.maintenance_status IN ('needs_maintenance','not_due') AND ${nextDueSql()} > @today`);
    } else {
      values.status = params.status;
      finalCond.push('d.maintenance_status = @status');
    }
  }
  if (params.cycle) {
    values.cycle = params.cycle;
    if (params.cycle === '2_weeks') {
      finalCond.push('d.maintenance_type IN (\'2_weeks\',\'2_week\')');
    } else {
      finalCond.push('d.maintenance_type = @cycle');
    }
  }
  if (params.due && params.due !== 'all') {
    // pending khong hien o tab Tre han ben bao tri (BI/admin van dem khi qua an han)
    if (params.due === 'overdue') finalCond.push(`${nextDueSql()} < @today AND d.maintenance_status <> 'pending_approval'`);
    else if (params.due === 'today') finalCond.push(`${nextDueSql()} = @today`);
    else if (params.due === 'tomorrow') finalCond.push(`${nextDueSql()} = @tomorrow`);
    else if (params.due === 'later') finalCond.push(`${nextDueSql()} > @tomorrow`);
  }
  const finalWhere = finalCond.length > 0 ? `WHERE ${finalCond.join(' AND ')}` : '';

  const totalRows = await query(
    `SELECT COUNT(*) AS total FROM eqm_mnt d ${joinSql} ${finalWhere}`,
    values,
  );
  const total = totalRows[0] ? totalRows[0].total : 0;

  const offset = (params.page - 1) * params.pageSize;
  values.offset = offset;
  values.pageSize = params.pageSize;
  const rows = await query(
    `SELECT ${DEVICE_SELECT}
     ${DEVICE_FROM} ${joinSql} ${finalWhere}
     ORDER BY ${orderByDeviceList(today)}
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    values,
  );

  const items = await enrichRecords(rows, today);
  return {
    items,
    position: caller.position,
    showMaintainer: SHOW_MAINTAINER_POSITIONS.includes(caller.position),
    total,
    page: params.page,
    pageSize: params.pageSize,
    dueCounts: { all: c.total, overdue: c.overdue, today: c.dueToday, tomorrow: c.dueTomorrow, later: c.dueLater },
    statusCounts: {
      all: c.total,
      needs_maintenance: c.stNeeds,
      in_maintenance: c.stInMaint,
      pending_approval: c.stPending,
      rejected: c.stRejected,
      not_due: c.stNotDue,
    },
    cycleCounts: { all: c.total, '1_week': c.cy1w, '2_weeks': c.cy2w, '1_month': c.cy1m, '1_year': c.cy1y },
  };
}

// ==== Tim kiem ====

async function lookupDeviceByQr(qr, userId) {
  // chi khop chinh xac ma thiet bi - khong co bat ky su sua loi nao
  const row = await queryOne(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.equ_no = @qr`, { qr });
  if (!row) throw new ApiError(404, 'DEVICE_NOT_FOUND');
  if (userId) {
    const caller = await getCaller(userId);
    if (caller.position !== 'admin' && row.mnt_dept_no !== caller.departmentId) {
      throw new ApiError(403, 'CROSS_DEPT_DEVICE');
    }
  }
  const today = businessToday();
  const [record] = await enrichRecords([row], today);
  return record;
}

async function listManagedDevices(userId, sortBy, page, pageSize) {
  const caller = await getCaller(userId);
  const xuongNos = await workshopService.getMemberXuongNos(caller.empNo);
  if (xuongNos.length === 0) return { items: [], total: 0, page, pageSize };
  const today = businessToday();
  const { sql: mgrInSql, params: mgrParams } = inClause(xuongNos, 'x');
  const where = `WHERE d.approver_emp_no IN (${mgrInSql})`;
  const values = { ...mgrParams };

  const totalRows = await query(`SELECT COUNT(*) AS total FROM eqm_mnt d ${where}`, values);
  const total = totalRows[0] ? totalRows[0].total : 0;

  const orderSql =
    sortBy === 'name'
      ? 'd.equ_name ASC, d.equ_no ASC'
      : `${nextDueSql()} ASC, d.equ_name ASC, d.equ_no ASC`;
  values.offset = (page - 1) * pageSize;
  values.pageSize = pageSize;
  values.today = today;
  const rows = await query(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} ${where}
     ORDER BY ${orderSql}
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    values,
  );
  const items = await enrichRecords(rows, today);
  return { items, total, page, pageSize };
}

async function listFactories(userId) {
  const caller = await getCaller(userId);
  const allowed =
    caller.position === 'admin' ||
    MAINTAINER_POSITIONS.includes(caller.position) ||
    caller.position === 'van_thu';
  if (!allowed) throw new ApiError(403, 'not allowed');
  // 2026-10-09: danh sach phan xuong tu bang xuong_mnt; approver = chu quan xuong
  const rows = await workshopService.listAllXuong();
  const items = rows.map((row) => {
    const head = row.chu_quan_emp_no || '';
    return {
      factory: row.xuong_no,
      // 2026-10-10: dropdown hien ten phong ban (bas_dept.dept_name) thay ma xuong
      factoryName: row.xuong_dept_name || row.xuong_name || row.xuong_no,
      approver: {
        userId: head,
        empNo: head,
        empName: row.emp_name || row.xuong_name || row.xuong_no,
      },
    };
  });
  return { items };
}

async function listMaintainerCandidates(userId) {
  const caller = await getCaller(userId);
  const allowed =
    caller.position === 'admin' ||
    MAINTAINER_POSITIONS.includes(caller.position) ||
    caller.position === 'van_thu';
  if (!allowed) throw new ApiError(403, 'not allowed');
  let where = 'WHERE position IN (\'nhan_vien_bao_tri\', \'chu_quan\')';
  const values = {};
  if (caller.position !== 'admin') {
    if (!caller.departmentId) return { items: [] };
    where += ' AND mnt_dept_no = @dept';
    values.dept = caller.departmentId;
  }
  const rows = await query(
    `SELECT id, emp_no, emp_name, position FROM emp_mnt ${where} ORDER BY emp_name ASC`,
    values,
  );
  return { items: rows.map((r) => ({ userId: r.emp_no, empNo: r.emp_no, empName: r.emp_name, position: r.position })) };
}

// ==== Cap nhat trang thai ====

async function updateDeviceStatus(id, status, userId) {
  if (!STATUS_ENUM.includes(status)) throw new ApiError(400, 'invalid status');
  const caller = await getCaller(userId);
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const today = businessToday();
  assertCanMaintain(caller, row, today);
  if (row.maintenance_status === 'pending_approval' && status !== 'pending_approval') {
    throw new ApiError(400, 'device is pending approval');
  }
  if (
    status === 'in_maintenance' &&
    row.maintenance_status === 'in_maintenance' &&
    effectiveMaintainerEmpNo(row, today) !== caller.empNo &&
    caller.position !== 'admin'
  ) {
    throw new ApiError(409, 'Device is being maintained by someone else');
  }

  const set = ['maintenance_status = @status'];
  const values = { status, id };
  if (status !== 'pending_approval') set.push('rejection_reason = NULL');
  if (
    status === 'in_maintenance' &&
    effectiveMaintainerEmpNo(row, today) !== caller.empNo &&
    caller.position !== 'admin'
  ) {
    set.push('temp_maintainer_emp_no = @tempEmp', 'temp_maintainer_date = @tempDate');
    values.tempEmp = caller.empNo;
    values.tempDate = today;
  }
  const updated = await query(
    `UPDATE eqm_mnt SET ${set.join(', ')}${touchSuffix()} OUTPUT inserted.id WHERE id = @id`,
    values,
  );
  if (updated.length === 0) throw new ApiError(404, 'Device not found');
  return { success: true };
}

// ==== Quy trinh xet duyet ====

function parsePending(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function generateSheetNo(tx, today) {
  // FIX #4: truy van truc tiep tien to ngay hom nay (ban cu chi lay 1000 dong khong thu tu)
  const [yy, mm, dd] = today.split('-').map((part, i) => (i === 0 ? part.slice(-2) : part));
  const prefix = `EMGIA${yy}${mm}${dd}`;
  const rows = await txQuery(tx, 'SELECT sheet_no FROM eqm_mt1 WHERE sheet_no LIKE @pfx', {
    pfx: `${prefix}%`,
  });
  let maxSeq = 0;
  for (const row of rows) {
    const suffix = String(row.sheet_no).slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      const seq = parseInt(suffix, 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  return prefix + String(maxSeq + 1).padStart(3, '0');
}

// Tao don bao duong khi duoc phe duyet (chi goi khi pending items khac rong)
async function finalizePendingOrder(tx, row, approverEmpNo, today) {
  const pending = parsePending(row.pending_maintenance_items);
  if (pending.length === 0) return null;
  const sheetNo = await generateSheetNo(tx, today);
  const maintainerEmpNo = (effectiveMaintainerEmpNo(row, today) || '').slice(0, 20);
  const sheetDate = row.completion_requested_at || new Date();
  await txQuery(
    tx,
    `INSERT INTO eqm_mt1 (sheet_no, sheet_type, sheet_date, dept_no, emp_no, mt_flag,
      equ_no, rem, create_date, check_date, create_user, check_user, sheet_sta, check_sta,
      user_list, cur_check_user)
     VALUES (@sheetNo, 'EMGIA', @sheetDate, @deptNo, @empNo, @mtFlag, @equNo, NULL,
       @createDate, GETDATE(), @empNo, @checkEmpNo, '1', '1', NULL, NULL)`,
    {
      sheetNo,
      sheetDate,
      // 2026-10-10 user chot: create_date = gio nhan vien gui xet duyet
      // (completion_requested_at, cung gia tri sheet_date), check_date = luc duyet
      createDate: sheetDate,
      deptNo: row.mnt_dept_no || null,
      empNo: maintainerEmpNo,
      mtFlag: cycleToMtFlag(row.maintenance_type),
      equNo: row.equ_no,
      checkEmpNo: (approverEmpNo || '').slice(0, 20),
    },
  );
  for (const item of pending) {
    await txQuery(
      tx,
      `INSERT INTO eqm_mt2 (sheet_no, fit_no, fit_name, mt_desc, rem, def01, def02, def03, def04, def05, def06)
       VALUES (@sheetNo, @fitNo, @fitName, @mtDesc, NULL, NULL, NULL, NULL, NULL, NULL, '0')`,
      {
        sheetNo,
        fitNo: item.fitNo,
        fitName: item.fitName || null,
        mtDesc: item.mtDesc || null,
      },
    );
  }
  return sheetNo;
}

// 2026-10-09: bo duyet theo bo phan (chu_quan/van_thu) — xet duyet chi con
// theo thanh vien phan xuong trong bang xuong_mnt
async function submitApproval(id, userId, itemIds) {
  const caller = await getCaller(userId);
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const today = businessToday();
  assertCanMaintain(caller, row, today);
  if (row.maintenance_status !== 'in_maintenance' && row.maintenance_status !== 'rejected') {
    throw new ApiError(400, 'Device must be in maintenance or rejected to request approval');
  }
  // 2026-10-06 user chot: chi nguoi dang chiu trach nhiem vong bao duong nay
  // (temp ?? maintainer) moi duoc gui xet duyet — truoc day nguoi khac trong bo phan
  // gui duoc va con ghi temp cuop viec cua nguoi dang lam
  if (
    effectiveMaintainerEmpNo(row) !== caller.empNo &&
    caller.position !== 'admin'
  ) {
    if (row.maintenance_status === 'in_maintenance') {
      throw new ApiError(
        409,
        'Thiết bị đang được người khác bảo trì, không thể gửi xét duyệt',
      );
    }
    throw new ApiError(
      403,
      'Chỉ người đang chịu trách nhiệm bảo trì mới được gửi lại xét duyệt',
    );
  }

  let pendingItems = parsePending(row.pending_maintenance_items);
  if (row.maintenance_status === 'in_maintenance') {
    if (!row.equ_type) {
      throw new ApiError(
        400,
        'Thiết bị chưa có loại (equ_type), không thể lấy hạng mục bảo dưỡng',
      );
    }
    if (!itemIds || itemIds.length === 0) {
      throw new ApiError(
        400,
        'Vui lòng chọn ít nhất 1 hạng mục bảo dưỡng trước khi gửi xét duyệt',
      );
    }
    pendingItems = await resolveSelectedTemplates(
      row.equ_type,
      cycleToMtFlag(row.maintenance_type),
      itemIds,
    );
    if (pendingItems.length === 0) {
      throw new ApiError(400, 'Không tìm thấy hạng mục đã chọn cho loại thiết bị này');
    }
  } else if (itemIds && itemIds.length > 0 && row.equ_type) {
    // rejected: cho phep chon lai hang muc truoc khi gui lai
    const resolved = await resolveSelectedTemplates(
      row.equ_type,
      cycleToMtFlag(row.maintenance_type),
      itemIds,
    );
    if (resolved.length > 0) pendingItems = resolved;
  }
  if (!pendingItems || pendingItems.length === 0) {
    throw new ApiError(
      400,
      'Chưa có hạng mục bảo dưỡng: vui lòng chọn ít nhất 1 hạng mục trước khi gửi xét duyệt',
    );
  }

  const set = ['pending_maintenance_items = @pending', 'rejection_reason = NULL'];
  const values = { id, pending: JSON.stringify(pendingItems) };
  set.push('maintenance_status = \'pending_approval\'', 'completion_requested_at = GETDATE()');
  const updated = await query(
    `UPDATE eqm_mnt SET ${set.join(', ')}${touchSuffix()} OUTPUT inserted.id WHERE id = @id`,
    values,
  );
  if (updated.length === 0) throw new ApiError(404, 'Device not found');
  return { success: true };
}

async function approveCompletion(id, userId) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const today = businessToday();
  // 2026-10-09: thanh vien phan xuong (xuong_mnt) hoac chu quan / van thu
  // cua bo phan thiet bi duoc duyet; nguoi dang bao tri van duoc duyet
  // thiet bi cua minh nhu truoc
  const isMember = await workshopService.isMemberOfXuong(requester.emp_no, row.approver_emp_no);
  const isDept = isDeptApprovalAllowed(requester, row);
  const isMaintainer = effectiveMaintainerEmpNo(row, today) === requester.emp_no;
  if (!isMember && !isDept && !isMaintainer) throw new ApiError(403, 'not allowed');
  if (row.maintenance_status !== 'pending_approval') {
    throw new ApiError(400, 'Device is not pending approval');
  }
  await withTransaction(async (tx) => {
    await finalizePendingOrder(tx, row, requester.emp_no, today);
    // FIX #2: max_mt_date lay theo ngay kinh doanh GMT+7 (ban cu dung UTC)
    await txQuery(
      tx,
      // Vong bao duong ket thuc: xoa temp de vong sau trach nhiem ve nguoi phu trach
      `UPDATE eqm_mnt SET maintenance_status = 'not_due', max_mt_date = @today,
        completion_requested_at = NULL,
        pending_maintenance_items = NULL,
        temp_maintainer_emp_no = NULL, temp_maintainer_date = NULL${touchSuffix()}
       WHERE id = @id`,
      { today, id },
    );
    // episode do dong tai thoi diem gui xet duyet (cong nhan NV da lam xong),
    // episode vang (cho duyet) dong tai thoi diem duyet. 2026-10-09
    await txQuery(
      tx,
      `UPDATE eqm_mnt_delay
       SET resolved_at = CASE WHEN reason = 'awaiting_approval' THEN GETDATE()
                              ELSE ISNULL(@reqAt, GETDATE()) END
       WHERE equ_no = @equNo AND resolved_at IS NULL`,
      { equNo: row.equ_no, reqAt: row.completion_requested_at || null },
    );
  });
  return { success: true };
}

async function rejectCompletion(id, userId, reason) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const isMember = await workshopService.isMemberOfXuong(requester.emp_no, row.approver_emp_no);
  const isDept = isDeptApprovalAllowed(requester, row);
  if (!isMember && !isDept) throw new ApiError(403, 'not owner');
  if (row.maintenance_status !== 'pending_approval') {
    throw new ApiError(400, 'Device is not pending approval');
  }
  const updated = await query(
    `UPDATE eqm_mnt SET maintenance_status = 'rejected', rejection_reason = @reason,
      completion_requested_at = NULL${touchSuffix()}
     OUTPUT inserted.id WHERE id = @id`,
    { reason, id },
  );
  if (updated.length === 0) throw new ApiError(404, 'Device not found');
  return { success: true };
}

async function bulkApproveCompletion(ids, userId) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  if (!ids || ids.length === 0) throw new ApiError(400, 'ids is required');
  const today = businessToday();
  const canDeptApprove =
    isDeptManagerPosition(requester.position || '') && !!requester.mnt_dept_no;
  const xuongNos = await workshopService.getMemberXuongNos(requester.emp_no);
  if (!canDeptApprove && xuongNos.length === 0) {
    return { success: true, processed: 0 };
  }
  const { sql: inSql, params } = inClause(ids, 'id');
  const scopeParts = [];
  const scopeParams = {};
  if (canDeptApprove) {
    scopeParts.push('d.mnt_dept_no = @callerDept');
    scopeParams.callerDept = requester.mnt_dept_no;
  }
  if (xuongNos.length > 0) {
    const { sql: xSql, params: xParams } = inClause(xuongNos, 'x');
    scopeParts.push(`d.approver_emp_no IN (${xSql})`);
    Object.assign(scopeParams, xParams);
  }
  const rows = await query(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM}
     WHERE d.id IN (${inSql}) AND d.maintenance_status = 'pending_approval'
       AND (${scopeParts.join(' OR ')})`,
    { ...params, ...scopeParams },
  );
  if (rows.length === 0) return { success: true, processed: 0 };
  await withTransaction(async (tx) => {
    for (const row of rows) {
      await finalizePendingOrder(tx, row, requester.emp_no, today);
    }
    const { sql: upIn, params: upParams } = inClause(rows.map((r) => r.id), 'u');
    await txQuery(
      tx,
      `UPDATE eqm_mnt SET maintenance_status = 'not_due', max_mt_date = @today,
        completion_requested_at = NULL,
        pending_maintenance_items = NULL,
        temp_maintainer_emp_no = NULL, temp_maintainer_date = NULL${touchSuffix()}
       WHERE id IN (${upIn})`,
      { ...upParams, today },
    );
    for (const r of rows) {
      await txQuery(
        tx,
        `UPDATE eqm_mnt_delay
         SET resolved_at = CASE WHEN reason = 'awaiting_approval' THEN GETDATE()
                                ELSE ISNULL(@reqAt, GETDATE()) END
         WHERE equ_no = @equNo AND resolved_at IS NULL`,
        { equNo: r.equ_no, reqAt: r.completion_requested_at || null },
      );
    }
  });
  return { success: true, processed: rows.length };
}

async function bulkRejectCompletion(ids, userId, reason) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  if (!ids || ids.length === 0) throw new ApiError(400, 'ids is required');
  const canDeptApprove =
    isDeptManagerPosition(requester.position || '') && !!requester.mnt_dept_no;
  const xuongNos = await workshopService.getMemberXuongNos(requester.emp_no);
  if (!canDeptApprove && xuongNos.length === 0) {
    return { success: true, processed: 0 };
  }
  const { sql: inSql, params } = inClause(ids, 'id');
  const scopeParts = [];
  const scopeParams = {};
  if (canDeptApprove) {
    scopeParts.push('mnt_dept_no = @callerDept');
    scopeParams.callerDept = requester.mnt_dept_no;
  }
  if (xuongNos.length > 0) {
    const { sql: xSql, params: xParams } = inClause(xuongNos, 'x');
    scopeParts.push(`approver_emp_no IN (${xSql})`);
    Object.assign(scopeParams, xParams);
  }
  const updated = await query(
    `UPDATE eqm_mnt SET maintenance_status = 'rejected', rejection_reason = @reason,
       completion_requested_at = NULL${touchSuffix()}
      OUTPUT inserted.id
     WHERE id IN (${inSql}) AND maintenance_status = 'pending_approval'
       AND (${scopeParts.join(' OR ')})`,
    { ...params, ...scopeParams, reason },
  );
  return { success: true, processed: updated.length };
}

// ==== Chuyen phan xuong ====

async function transferFactory(id, body, userId) {
  const caller = await getCaller(userId);
  const allowed =
    caller.position === 'admin' ||
    MAINTAINER_POSITIONS.includes(caller.position) ||
    caller.position === 'van_thu';
  if (!allowed) throw new ApiError(403, 'not allowed');
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  if (caller.position !== 'admin' && row.mnt_dept_no !== caller.departmentId) {
    throw new ApiError(403, 'Device belongs to another department');
  }
  // 2026-10-09: dich chuyen theo phan xuong — approver_emp_no = ma phan xuong
  const xuong = await workshopService.getXuong(body.targetFactory);
  if (!xuong) throw new ApiError(400, 'Factory not found');

  let maintainerTarget = null;
  if (body.newMaintainerId) {
    const target = await resolveUser(body.newMaintainerId);
    if (!target) throw new ApiError(404, 'Maintainer not found');
    if (!MAINTAINER_POSITIONS.includes(target.position)) {
      throw new ApiError(400, 'Invalid maintainer');
    }
    if (caller.position !== 'admin' && target.mnt_dept_no !== caller.departmentId) {
      throw new ApiError(403, 'Maintainer outside caller department');
    }
    maintainerTarget = { empNo: target.emp_no, departmentId: target.mnt_dept_no || null };
  }

  const set = ['approver_emp_no = @approver', 'equ_addr = @factory'];
  const values = { approver: body.targetFactory, factory: body.targetFactory, id };
  if (maintainerTarget) {
    set.push(
      'maintainer_emp_no = @newMaintainer',
      'mnt_dept_no = @newDept',
      'temp_maintainer_emp_no = NULL',
      'temp_maintainer_date = NULL',
    );
    values.newMaintainer = maintainerTarget.empNo;
    values.newDept = maintainerTarget.departmentId;
  }
  const updated = await query(
    `UPDATE eqm_mnt SET ${set.join(', ')}${touchSuffix()} OUTPUT inserted.id WHERE id = @id`,
    values,
  );
  if (updated.length === 0) throw new ApiError(404, 'Device not found');
  const device = await getDeviceById(id);
  return { success: true, device };
}

// ==== Hoan tac bao duong ====

async function undoMaintenance(id, userId) {
  const caller = await getCaller(userId);
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  if (row.maintenance_status !== 'in_maintenance' && row.maintenance_status !== 'rejected') {
    throw new ApiError(400, 'Device is not in maintenance or rejected');
  }
  const today = businessToday();
  const scannerId = row.temp_maintainer_emp_no || row.maintainer_emp_no;
  const isDeptManager =
    isDeptManagerPosition(caller.position) &&
    !!caller.departmentId &&
    row.mnt_dept_no === caller.departmentId;
  if (caller.empNo !== scannerId && !isDeptManager) {
    throw new ApiError(403, 'Only the maintenance staff or department manager can undo');
  }
  const nextDue = holidayService.shiftPastHolidays(getNextDueDay({
    startDate: row.use_date,
    lastMaintenanceDate: row.max_mt_date,
    maintenanceCycle: row.maintenance_type,
  }));
  const newStatus = nextDue && nextDue <= today ? 'needs_maintenance' : 'not_due';
  const updated = await query(
    `UPDATE eqm_mnt SET maintenance_status = @status,
      temp_maintainer_emp_no = NULL, temp_maintainer_date = NULL,
      rejection_reason = NULL, completion_requested_at = NULL,
      pending_maintenance_items = NULL${touchSuffix()}
     OUTPUT inserted.id WHERE id = @id`,
    { status: newStatus, id },
  );
  if (updated.length === 0) throw new ApiError(404, 'Device not found');
  return { success: true, newStatus };
}

module.exports = {
  listDevices,
  lookupDeviceByQr,
  listManagedDevices,
  listFactories,
  listMaintainerCandidates,
  getDeviceById,
  updateDeviceStatus,
  submitApproval,
  approveCompletion,
  rejectCompletion,
  bulkApproveCompletion,
  bulkRejectCompletion,
  transferFactory,
  undoMaintenance,
};
