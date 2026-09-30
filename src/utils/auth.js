const { query, queryOne } = require('../db');
const { ApiError } = require('../errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAINTAINER_POSITIONS = ['nhan_vien_bao_tri', 'chu_quan'];
const DEPT_MANAGER_POSITIONS = ['chu_quan', 'van_thu'];
const VIEW_ALL_POSITIONS = ['admin', 'approver', 'chu_quan', 'van_thu'];

function isDeptManagerPosition(position) {
  return DEPT_MANAGER_POSITIONS.includes(position);
}

// Dang nhap / quan ly tai khoan: luon tra theo MNV (emp_no)
async function resolveByEmpNo(empNo) {
  if (!empNo) return null;
  return queryOne('SELECT * FROM emp_mnt WHERE emp_no = @e', { e: String(empNo) });
}

// Route nghiep vu: chap nhan id so (uu tien), MNV, hoac lark_user_id (uuid cu)
async function resolveUser(userId) {
  if (!userId) return null;
  const id = String(userId);
  if (UUID_RE.test(id)) {
    return queryOne('SELECT * FROM emp_mnt WHERE lark_user_id = @u', { u: id });
  }
  const byId = await queryOne('SELECT * FROM emp_mnt WHERE id = @id', { id });
  if (byId) return byId;
  return queryOne('SELECT * FROM emp_mnt WHERE emp_no = @e', { e: id });
}

function toPublicUser(row) {
  return {
    userId: row.id,
    empNo: row.emp_no,
    empName: row.emp_name || row.emp_no,
    position: row.position || '',
    avatarUrl: row.avatar_url || '',
    hasPin: Boolean(row.pin_hash),
    hasFace: Boolean(row.face_image_url),
  };
}

function toUser(row) {
  return { userId: row.id, empNo: row.emp_no, empName: row.emp_name };
}

// Nguoi goi da xac thuc (bat buoc co userId hop le)
async function getCaller(userId) {
  const row = await resolveUser(userId);
  if (!row) throw new ApiError(404, 'User not found');
  return {
    id: row.id,
    empNo: row.emp_no,
    position: row.position || '',
    departmentId: row.mnt_dept_no || null,
  };
}

function assertAdmin(position) {
  if (position !== 'admin') throw new ApiError(403, 'not admin');
}

module.exports = {
  UUID_RE,
  resolveByEmpNo,
  MAINTAINER_POSITIONS,
  DEPT_MANAGER_POSITIONS,
  VIEW_ALL_POSITIONS,
  isDeptManagerPosition,
  resolveUser,
  toPublicUser,
  toUser,
  getCaller,
  assertAdmin,
  query,
};
