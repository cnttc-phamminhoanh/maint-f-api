const { query, queryOne, withTransaction, txQuery, inClause, inClauseSafe } = require('../db');
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
  effectiveStatus,
  isTempActive,
  effectiveMaintainerEmpNo,
} = require('../utils/dates');
const { resolveSelectedTemplates, cycleToMtFlag } = require('./maintenance-order.service');
const dueSchedule = require('./due-schedule.service');
const pushService = require('../push/push.service');

// 2026-10-23: ngay han = ngay goc (max_mt_date ?? use_date) + chu ky, roi vao ngay nghi
// (Chu nhat + hr_holiday) thi TRUOT CHUYEN DAY CHUYEN (due-schedule.service): me roi ngay
// nghi day sang ngay ke; ngay nhan da co me rieng thi me do lai day tiep; moi ngay chi nhan
// mot me som nhat; chuoi dung o ngay trong dau tien. => khong con tinh per-row trong SQL;
// trang thai / loc / dem / sap xep lam trong JS tren han truot chuyen.

const DEVICE_SELECT = `d.id, d.equ_no, d.equ_name, d.use_date, d.max_mt_date,
  d.maintenance_type, d.maintenance_status, d.completion_requested_at, d.rejection_reason,
  d.maintainer_emp_no, d.approver AS approver_emp_no, d.temp_maintainer_emp_no, d.temp_maintainer_date,
  d.location, d.equ_type, d.equ_type_desc, d.mnt_dept_no, d.pending_maintenance_items,
  bc.base_name AS location_name`;

// 2026-10-17: vi tri thiet bi = bas_base_code.base_name (code_type '176')
// theo cot eqm_mnt.location (cot equ_addr da bi user xoa, join bas_dept bo)
const DEVICE_FROM = `FROM eqm_mnt d
  LEFT JOIN dbo.bas_base_code bc ON bc.base_code = d.location AND bc.code_type = '176'`;

// Truy van danh sach can _updated_at de sap xep nhom in_maintenance trong JS
function deviceSelectSql() {
  return config.updatedAtCol ? `${DEVICE_SELECT}, d.${config.updatedAtCol}` : DEVICE_SELECT;
}

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

// ==== Han truot chuyen (2026-10-23) ====
// Han sau truot cua tung thiet bi tra tu lich toan cuc (due-schedule.service);
// loc trang thai / chu ky / thoi han, dem va sap xep lam trong JS.
function decorateRows(rows, dueMap, redMap, today) {
  return rows.map((row) => {
    const due = dueMap.get(row.equ_no) || null;
    // 2026-10-27: thiet bi con episode do mo = dang tre han (nam ngoai hang doi)
    const red = redMap.has(row.equ_no);
    const status = effectiveStatus(
      {
        maintenanceStatus: row.maintenance_status,
        startDate: row.use_date,
        lastMaintenanceDate: row.max_mt_date,
        maintenanceCycle: row.maintenance_type,
      },
      today,
      due,
    );
    return { row, due, red, status };
  });
}

function passStatusFilter(ctx, statusFilter) {
  return !statusFilter || ctx.status === statusFilter;
}

function passCycleFilter(row, cycleFilter) {
  if (!cycleFilter) return true;
  if (cycleFilter === '2_weeks') {
    return row.maintenance_type === '2_weeks' || row.maintenance_type === '2_week';
  }
  return row.maintenance_type === cycleFilter;
}

function passDueFilter(ctx, dueFilter, today, tomorrow) {
  if (!dueFilter || dueFilter === 'all') return true;
  if (dueFilter === 'overdue') return ctx.red;
  if (!ctx.due) return false;
  if (dueFilter === 'today') return ctx.due === today;
  if (dueFilter === 'tomorrow') return ctx.due === tomorrow;
  return ctx.due > tomorrow; // later
}

function statusPriority(ctx, today) {
  if (ctx.status === 'in_maintenance') return 1;
  if (ctx.status === 'pending_approval') return 2;
  if (ctx.status === 'rejected') return 3;
  if (ctx.red || (ctx.due && ctx.due <= today)) return 4;
  return 5;
}

function compareDeviceOrder(a, b, today) {
  const pa = statusPriority(a, today);
  const pb = statusPriority(b, today);
  if (pa !== pb) return pa - pb;
  if (pa === 1 && config.updatedAtCol) {
    const ta = a.row[config.updatedAtCol] ? new Date(a.row[config.updatedAtCol]).getTime() : 0;
    const tb = b.row[config.updatedAtCol] ? new Date(b.row[config.updatedAtCol]).getTime() : 0;
    if (ta !== tb) return tb - ta; // vua quet len dau
  }
  const da = a.due || '9999-12-31';
  const db = b.due || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  if (a.row.equ_no !== b.row.equ_no) return a.row.equ_no < b.row.equ_no ? -1 : 1;
  return 0;
}

async function getEmpNameMap(empNos) {
  const unique = [...new Set(empNos.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;
  const { sql: inSql, params } = inClauseSafe(unique, 'e');
  const rows = await query(
    `SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${inSql})`,
    params,
  );
  for (const row of rows) map.set(row.emp_no, row.emp_name || '');
  return map;
}

function toDeviceRecord(row, empNameMap, today, firstApproverMap, factoryNameMap, dueMap) {
  const effectiveId = effectiveMaintainerEmpNo(row, today);
  const maintainerId = row.maintainer_emp_no || '';
  // 2026-10-17: approver = l_code (eqm_bas_user); Nguoi quan ly = approver dau tien
  // cua nhom l_code (emp_no nho nhat). Nhom chua co thanh vien -> khong co quan ly
  const managerCode = row.approver_emp_no || '';
  const firstApprover = managerCode && firstApproverMap
    ? firstApproverMap.get(managerCode)
    : undefined;
  const managerId = firstApprover ? (firstApprover.empNo || '') : '';
  // 2026-10-23: han truot chuyen tra tu lich toan cuc (khong con tinh per-row)
  const adjustedDue = dueMap.get(row.equ_no) || null;
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
    // 2026-10-17: approver = l_code (eqm_bas_user); factoryName = base_name cua l_code
    // (FE transfer dung factory de loai nhom hien tai khoi dropdown)
    factory: row.approver_emp_no || '',
    factoryName:
      row.approver_emp_no && factoryNameMap
        ? factoryNameMap.get(row.approver_emp_no) || ''
        : '',
    location: row.location || '',
    locationName: row.location_name || '',
    equType: row.equ_type || '',
    equTypeDesc: row.equ_type_desc || '',
    // 2026-10-23: han truot chuyen (FE dung gia tri nay, khong tu tinh dia phuong)
    nextDueDate: adjustedDue || '',
  };
}

// Map l_code -> base_name (cung nguon voi Vi tri dat thiet bi)
async function getFactoryNameMap(lCodes) {
  const map = new Map();
  if (!lCodes || lCodes.length === 0) return map;
  const { sql, params } = inClauseSafe(lCodes, 'b');
  const rows = await query(
    `SELECT base_code, base_name FROM dbo.bas_base_code
      WHERE code_type = '176' AND base_code IN (${sql})`,
    params,
  );
  for (const r of rows) map.set(r.base_code, r.base_name || '');
  return map;
}

async function enrichRecords(rows, today, dueMap) {
  // 2026-10-17: approver = l_code (eqm_bas_user); Nguoi quan ly = approver dau tien cua nhom
  const lCodes = [...new Set(rows.map((row) => row.approver_emp_no).filter(Boolean))];
  const firstApproverMap = await workshopService.getFirstApproverMap(lCodes);
  const factoryNameMap = await getFactoryNameMap(lCodes);
  const empNos = [];
  for (const row of rows) {
    const effective = effectiveMaintainerEmpNo(row, today);
    if (effective) empNos.push(effective);
    if (row.maintainer_emp_no) empNos.push(row.maintainer_emp_no);
  }
  for (const info of firstApproverMap.values()) {
    if (info.empNo) empNos.push(info.empNo);
  }
  const map = await getEmpNameMap(empNos);
  const effectiveDueMap = dueMap || (await dueSchedule.getEffectiveDueMap());
  return rows.map((row) => toDeviceRecord(row, map, today, firstApproverMap, factoryNameMap, effectiveDueMap));
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

async function buildScopeCondition(params, caller, values, _today) {
  // 2026-10-17: thiet bi can duyet = pending_approval ma nhom l_code
  // (eqm_bas_user) cua thiet bi co chua nguoi goi (approver / chu quan / van thu)
  if (params.approvalOnly) {
    const lCodes = await workshopService.getMemberLCodes(caller.empNo);
    if (lCodes.length === 0) return null;
    const { sql, params: xParams } = inClause(lCodes, 'x');
    Object.assign(values, xParams);
    return [
      'd.maintenance_status = \'pending_approval\'',
      `d.approver IN (${sql})`,
    ];
  }
  if (params.scope === 'mine') {
    values.callerEmpNo = caller.empNo;
    return ['d.maintainer_emp_no = @callerEmpNo'];
  }
  // scope=scanned: thiet bi do chinh nguoi goi quet ma (temp hoac maintainer chua ai
  // tiep quan) va dang o trang thai lam viec (bao duong / cho duyet / bi tu choi)
  if (params.scope === 'scanned') {
    values.callerEmpNo = caller.empNo;
    return [
      `((d.temp_maintainer_emp_no = @callerEmpNo
          OR (d.maintainer_emp_no = @callerEmpNo AND d.temp_maintainer_emp_no IS NULL))
        AND d.maintenance_status IN ('in_maintenance', 'rejected', 'pending_approval'))`,
    ];
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
    const lCodes = await workshopService.getMemberLCodes(caller.empNo);
    if (lCodes.length === 0) return ['1 = 0'];
    const { sql, params: xParams } = inClause(lCodes, 'x');
    Object.assign(values, xParams);
    return [`d.maintenance_status = 'pending_approval' AND d.approver IN (${sql})`];
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

// Dieu kien loc dung chung cho listDevices va listDeviceIds
// (search / status / cycle / due, tra ve null = tam nhin rong)
async function buildFilterConditions(params, caller, values) {
  const today = businessToday();
  const scopeCond = await buildScopeCondition(params, caller, values, today);
  if (scopeCond === null) return null;
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

  // 2026-10-23: loc status / cycle / due lam trong JS tren han truot chuyen
  return { cond, joinSql };
}

async function listDevices(params) {
  const caller = await getCaller(params.userId);
  const today = businessToday();
  const tomorrow = addDays(today, 1);
  const values = {};

  const built = await buildFilterConditions(params, caller, values);
  if (built === null) {
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
  const where = built.cond.length > 0 ? `WHERE ${built.cond.join(' AND ')}` : '';
  const rows = await query(
    `SELECT ${deviceSelectSql()} ${DEVICE_FROM} ${built.joinSql} ${where}`,
    values,
  );

  // 2026-10-27: han theo hang doi bo phan + tap thiet bi do (episode mo)
  const dueMap = await dueSchedule.getEffectiveDueMap();
  const redMap = await dueSchedule.getRedDeviceMap();
  const decorated = decorateRows(rows, dueMap, redMap, today);

  // dem theo thoi han + trang thai + chu ky (tinh tren dieu kien goc, chua loc status/due/cycle)
  const dueCounts = { all: decorated.length, overdue: 0, today: 0, tomorrow: 0, later: 0 };
  const statusCounts = {
    all: decorated.length,
    needs_maintenance: 0,
    in_maintenance: 0,
    pending_approval: 0,
    rejected: 0,
    not_due: 0,
  };
  const cycleCounts = { all: decorated.length, '1_week': 0, '2_weeks': 0, '1_month': 0, '1_year': 0 };
  for (const ctx of decorated) {
    if (ctx.red) {
      dueCounts.overdue += 1;
    } else if (ctx.due) {
      if (ctx.due === today) dueCounts.today += 1;
      else if (ctx.due === tomorrow) dueCounts.tomorrow += 1;
      else if (ctx.due > tomorrow) dueCounts.later += 1;
    }
    if (statusCounts[ctx.status] !== undefined) statusCounts[ctx.status] += 1;
    const cycle = ctx.row.maintenance_type === '2_week' ? '2_weeks' : ctx.row.maintenance_type;
    if (cycleCounts[cycle] !== undefined) cycleCounts[cycle] += 1;
  }

  const filtered = decorated.filter((ctx) =>
    passStatusFilter(ctx, params.status) &&
    passCycleFilter(ctx.row, params.cycle) &&
    passDueFilter(ctx, params.due, today, tomorrow));
  filtered.sort((a, b) => compareDeviceOrder(a, b, today));

  const total = filtered.length;
  const offset = (params.page - 1) * params.pageSize;
  const pageRows = filtered.slice(offset, offset + params.pageSize).map((ctx) => ctx.row);
  const items = await enrichRecords(pageRows, today, dueMap);
  return {
    items,
    position: caller.position,
    showMaintainer: SHOW_MAINTAINER_POSITIONS.includes(caller.position),
    total,
    page: params.page,
    pageSize: params.pageSize,
    dueCounts,
    statusCounts,
    cycleCounts,
  };
}

// 2026-10-14: endpoint nhe cho «Chon tat ca» cua FE — chi tra id theo dung
// filter hien tai, khong enrich tung dong
async function listDeviceIds(params) {
  const caller = await getCaller(params.userId);
  const today = businessToday();
  const tomorrow = addDays(today, 1);
  const values = {};

  const built = await buildFilterConditions(params, caller, values);
  if (built === null) return { ids: [], total: 0 };
  const where = built.cond.length > 0 ? `WHERE ${built.cond.join(' AND ')}` : '';
  const rows = await query(
    `SELECT ${deviceSelectSql()} ${DEVICE_FROM} ${built.joinSql} ${where}`,
    values,
  );
  const dueMap = await dueSchedule.getEffectiveDueMap();
  const redMap = await dueSchedule.getRedDeviceMap();
  const filtered = decorateRows(rows, dueMap, redMap, today).filter((ctx) =>
    passStatusFilter(ctx, params.status) &&
    passCycleFilter(ctx.row, params.cycle) &&
    passDueFilter(ctx, params.due, today, tomorrow));
  filtered.sort((a, b) => compareDeviceOrder(a, b, today));
  return { ids: filtered.map((ctx) => String(ctx.row.id)), total: filtered.length };
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
  const lCodes = await workshopService.getMemberLCodes(caller.empNo);
  if (lCodes.length === 0) return { items: [], total: 0, page, pageSize };
  const today = businessToday();
  const { sql: mgrInSql, params: mgrParams } = inClause(lCodes, 'x');
  const where = `WHERE d.approver IN (${mgrInSql})`;

  const rows = await query(`SELECT ${deviceSelectSql()} ${DEVICE_FROM} ${where}`, mgrParams);
  const dueMap = await dueSchedule.getEffectiveDueMap();
  const redMap = await dueSchedule.getRedDeviceMap();
  const decorated = rows.map((row) => ({
    row,
    due: dueMap.get(row.equ_no) || null,
    red: redMap.has(row.equ_no),
  }));
  // 2026-10-23: sap xep trong JS tren han truot chuyen (SQL per-row da bo)
  decorated.sort((a, b) => {
    if (sortBy === 'name') {
      const na = String(a.row.equ_name || '').localeCompare(String(b.row.equ_name || ''));
      if (na !== 0) return na;
    } else {
      const da = a.due || '9999-12-31';
      const db = b.due || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
    }
    if (a.row.equ_no !== b.row.equ_no) return a.row.equ_no < b.row.equ_no ? -1 : 1;
    return 0;
  });
  const total = decorated.length;
  const offset = (page - 1) * pageSize;
  const pageRows = decorated.slice(offset, offset + pageSize).map((ctx) => ctx.row);
  const items = await enrichRecords(pageRows, today, dueMap);
  return { items, total, page, pageSize };
}

async function listFactories(userId) {
  const caller = await getCaller(userId);
  const allowed =
    caller.position === 'admin' ||
    MAINTAINER_POSITIONS.includes(caller.position) ||
    caller.position === 'van_thu';
  if (!allowed) throw new ApiError(403, 'not allowed');
  // 2026-10-17: dropdown = l_code phan biet trong eqm_bas_user,
  // ten hien base_name (bas_base_code, code_type 176), khong kem ten approver
  const rows = await workshopService.listLCodeOptions();
  const items = rows.map((row) => {
    return {
      factory: row.l_code,
      factoryName: row.base_name || row.l_code,
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
  let where =
    'WHERE position IN (\'nhan_vien_bao_tri\', \'chu_quan\', \'van_thu\')';
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

// 2026-10-17: xet duyet theo nhom l_code trong bang eqm_bas_user
// (chi chua approver / chu quan / van thu); khong con duyet theo bo phan
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
  // Bao nhom duyet (fire-and-forget, khong anh huong nghiep vu)
  pushService.dispatchApprovalEvent('submitted', row, caller.empNo)
    .catch((err) => console.error('[push]', err.message));
  return { success: true };
}

async function approveCompletion(id, userId) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const today = businessToday();
  // 2026-10-15 user chot: chi nhan_vien_bao_tri bi chan tu duyet don cua
  // chinh minh; chu_quan / van_thu / thanh vien phan xuong tu quet bao tri
  // roi gui xet duyet van duoc tu duyet don minh gui nhu binh thuong
  if (
    requester.position === 'nhan_vien_bao_tri' &&
    effectiveMaintainerEmpNo(row, today) === requester.emp_no
  ) {
    throw new ApiError(403, 'not allowed');
  }
  // 2026-10-17: quyen duyet = thanh vien nhom l_code (eqm_bas_user) cua thiet bi, hoac admin
  const isMember = await workshopService.isMemberOfLCode(requester.emp_no, row.approver_emp_no);
  if (!isMember && requester.position !== 'admin') throw new ApiError(403, 'not allowed');
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
  // max_mt_date doi => lich han truot chuyen het han
  dueSchedule.invalidateSchedule();
  // Bao nhom duyet con lai + nguoi gui don (fire-and-forget)
  pushService.dispatchApprovalEvent('approved', row, requester.emp_no)
    .catch((err) => console.error('[push]', err.message));
  return { success: true };
}

async function rejectCompletion(id, userId, reason) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  const row = await getDeviceRow(id);
  if (!row) throw new ApiError(404, 'Device not found');
  const isMember = await workshopService.isMemberOfLCode(requester.emp_no, row.approver_emp_no);
  if (!isMember && requester.position !== 'admin') throw new ApiError(403, 'not owner');
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
  // Bao nhom duyet con lai + nguoi gui don (fire-and-forget)
  pushService.dispatchApprovalEvent('rejected', row, requester.emp_no)
    .catch((err) => console.error('[push]', err.message));
  return { success: true };
}

async function bulkApproveCompletion(ids, userId) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  if (!ids || ids.length === 0) throw new ApiError(400, 'ids is required');
  const today = businessToday();
  const isAdmin = requester.position === 'admin';
  const lCodes = await workshopService.getMemberLCodes(requester.emp_no);
  if (!isAdmin && lCodes.length === 0) {
    return { success: true, processed: 0 };
  }
  const { sql: inSql, params } = inClause(ids, 'id');
  const scopeParts = [];
  const scopeParams = {};
  if (isAdmin) {
    scopeParts.push('1 = 1');
  } else {
    const { sql: xSql, params: xParams } = inClause(lCodes, 'x');
    scopeParts.push(`d.approver IN (${xSql})`);
    Object.assign(scopeParams, xParams);
  }
  // 2026-10-15 user chot: chi nhan_vien_bao_tri bi chan tu duyet don cua minh
  let selfGuardSql = '';
  if (requester.position === 'nhan_vien_bao_tri') {
    scopeParams.reqEmp = requester.emp_no;
    selfGuardSql = `
       AND (ISNULL(d.temp_maintainer_emp_no, d.maintainer_emp_no) IS NULL
         OR ISNULL(d.temp_maintainer_emp_no, d.maintainer_emp_no) <> @reqEmp)`;
  }
  const rows = await query(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM}
     WHERE d.id IN (${inSql}) AND d.maintenance_status = 'pending_approval'
       AND (${scopeParts.join(' OR ')})${selfGuardSql}`,
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
  // max_mt_date doi => lich han truot chuyen het han
  dueSchedule.invalidateSchedule();
  // Bao theo tung thiet bi trong ket qua (fire-and-forget)
  for (const r of rows) {
    pushService.dispatchApprovalEvent('approved', r, requester.emp_no)
      .catch((err) => console.error('[push]', err.message));
  }
  return { success: true, processed: rows.length };
}

async function bulkRejectCompletion(ids, userId, reason) {
  const requester = await resolveUser(userId);
  if (!requester) throw new ApiError(404, 'User not found');
  if (!ids || ids.length === 0) throw new ApiError(400, 'ids is required');
  const isAdmin = requester.position === 'admin';
  const lCodes = await workshopService.getMemberLCodes(requester.emp_no);
  if (!isAdmin && lCodes.length === 0) {
    return { success: true, processed: 0 };
  }
  const { sql: inSql, params } = inClause(ids, 'id');
  const scopeParts = [];
  const scopeParams = {};
  if (isAdmin) {
    scopeParts.push('1 = 1');
  } else {
    const { sql: xSql, params: xParams } = inClause(lCodes, 'x');
    scopeParts.push(`approver IN (${xSql})`);
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
  // Bulk reject chi co id trong ket qua -> doc lai row thiet bi de dispatch
  if (updated.length > 0) {
    const { sql: rIn, params: rParams } = inClause(updated.map((u) => u.id), 'r');
    const rows = await query(
      `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.id IN (${rIn})`,
      rParams,
    );
    for (const r of rows) {
      pushService.dispatchApprovalEvent('rejected', r, requester.emp_no)
        .catch((err) => console.error('[push]', err.message));
    }
  }
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
  // 2026-10-24 user chot: doi 1 trong 2 (phan xuong / nguoi phu trach) hoac ca hai
  const targetFactory = body.targetFactory || null;
  if (!targetFactory && !body.newMaintainerId) {
    throw new ApiError(400, 'Nothing to change');
  }
  if (targetFactory) {
    const hasGroup = await workshopService.lCodeExists(targetFactory);
    if (!hasGroup) throw new ApiError(400, 'Factory not found');
  }

  let maintainerTarget = null;
  if (body.newMaintainerId) {
    const target = await resolveUser(body.newMaintainerId);
    if (!target) throw new ApiError(404, 'Maintainer not found');
    if (
      !MAINTAINER_POSITIONS.includes(target.position) &&
      target.position !== 'van_thu'
    ) {
      throw new ApiError(400, 'Invalid maintainer');
    }
    if (caller.position !== 'admin' && target.mnt_dept_no !== caller.departmentId) {
      throw new ApiError(403, 'Maintainer outside caller department');
    }
    maintainerTarget = { empNo: target.emp_no, departmentId: target.mnt_dept_no || null };
  }

  // 2026-10-17: equ_addr da bi user xoa; ma xuong ghi vao approver + location
  const set = [];
  const values = { id, equNo: row.equ_no };
  if (targetFactory) {
    set.push('approver = @factory', 'location = @factory');
    values.factory = targetFactory;
  }
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
  // eqm_bas: chi dung 2 cot def04 (= location) va emp_no (= nguoi phu trach)
  const basEmpNo = maintainerTarget
    ? maintainerTarget.empNo
    : targetFactory
      ? row.maintainer_emp_no
      : null;
  const basSet = [];
  if (targetFactory) basSet.push('def04 = @factory');
  if (basEmpNo) basSet.push('emp_no = @basEmp');
  values.basEmp = basEmpNo;

  await withTransaction(async (tx) => {
    const updated = await txQuery(
      tx,
      `UPDATE eqm_mnt SET ${set.join(', ')}${touchSuffix()} OUTPUT inserted.id WHERE id = @id`,
      values,
    );
    if (updated.length === 0) throw new ApiError(404, 'Device not found');
    // eqm_bas la bang ERP co the gan trigger: OUTPUT khong INTO se bao loi 334
    const basUpdated = await txQuery(
      tx,
      `UPDATE eqm_bas SET ${basSet.join(', ')} WHERE equ_no = @equNo; SELECT @@ROWCOUNT AS cnt;`,
      values,
    );
    if ((basUpdated[0]?.cnt ?? 0) === 0) {
      throw new ApiError(
        409,
        `Device not found in eqm_bas (equ_no=${row.equ_no})`,
      );
    }
  });
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
  // 2026-10-23: han truot chuyen tra tu lich toan cuc (khong tinh per-row)
  const dueMap = await dueSchedule.getEffectiveDueMap();
  const nextDue = dueMap.get(row.equ_no) || null;
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
  listDeviceIds,
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
