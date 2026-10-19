const { query, queryOne } = require('../db');

// Nhom duyet (2026-10-17 user chot): bang eqm_bas_user (l_code + emp_no),
// chi chua approver / chu quan / van thu (khong co nhan_vien_bao_tri).
// eqm_mnt.approver chua l_code; quyen duyet = moi thanh vien eqm_bas_user
// co l_code do. Bang xuong_mnt khong con duoc dung trong luong duyet.

async function getMemberLCodes(empNo) {
  if (!empNo) return [];
  const rows = await query(
    'SELECT l_code FROM eqm_bas_user WHERE emp_no = @e ORDER BY l_code ASC',
    { e: empNo },
  );
  return rows.map((r) => r.l_code);
}

async function isMemberOfLCode(empNo, lCode) {
  if (!empNo || !lCode) return false;
  const row = await queryOne(
    'SELECT TOP 1 l_code FROM eqm_bas_user WHERE l_code = @l AND emp_no = @e',
    { l: lCode, e: empNo },
  );
  return Boolean(row);
}

async function lCodeExists(lCode) {
  if (!lCode) return false;
  const row = await queryOne(
    'SELECT TOP 1 l_code FROM eqm_bas_user WHERE l_code = @l',
    { l: lCode },
  );
  return Boolean(row);
}

// Map l_code -> [{empNo, empName, position}] theo emp_no SO tang dan
// (phan tu dau = approver dau tien = Nguoi quan ly thiet bi)
// emp_no la varchar: sort chuoi se nho ('12442' < '5454') -> phai TRY_CAST sang INT
// (2026-10-19 user hoi vi sao manager LE05 la 12442 du 5454 nho hon)
async function getGroupMembersMap(lCodes) {
  const map = new Map();
  if (!lCodes || lCodes.length === 0) return map;
  const params = {};
  const placeholders = lCodes.map((c, i) => {
    params[`l${i}`] = c;
    return `@l${i}`;
  });
  const rows = await query(
    `SELECT u.l_code, u.emp_no, ISNULL(e.emp_name, u.emp_name) AS emp_name,
            ISNULL(e.position, '') AS position
       FROM eqm_bas_user u
       LEFT JOIN emp_mnt e ON e.emp_no = u.emp_no
        WHERE u.l_code IN (${placeholders.join(',')})
        ORDER BY u.l_code ASC,
                 CASE WHEN u.emp_no LIKE '%[^0-9]%' THEN 1 ELSE 0 END ASC,
                 TRY_CAST(u.emp_no AS INT) ASC,
                 u.emp_no ASC`,
    params,
  );
  for (const r of rows) {
    if (!map.has(r.l_code)) map.set(r.l_code, []);
    map.get(r.l_code).push({
      empNo: r.emp_no,
      empName: r.emp_name || '',
      position: r.position || '',
    });
  }
  return map;
}

async function getGroupMembers(lCode) {
  if (!lCode) return [];
  const map = await getGroupMembersMap([lCode]);
  return map.get(lCode) || [];
}

// Map l_code -> approver dau tien (emp_no nho nhat, co dinh)
async function getFirstApproverMap(lCodes) {
  const groups = await getGroupMembersMap(lCodes);
  const map = new Map();
  for (const [lCode, members] of groups) {
    if (members.length > 0) map.set(lCode, members[0]);
  }
  return map;
}

// Dropdown chuyen phan xuong: l_code phan biet trong eqm_bas_user +
// ten base_name (bas_base_code, code_type 176 — cung nguon voi Vi tri dat thiet bi)
async function listLCodeOptions() {
  return query(
    `SELECT u.l_code, bc.base_name
       FROM (SELECT DISTINCT l_code FROM eqm_bas_user) u
       LEFT JOIN dbo.bas_base_code bc
         ON bc.base_code = u.l_code AND bc.code_type = '176'
      ORDER BY COALESCE(bc.base_name, u.l_code) ASC`,
  );
}

// Nhom l_code cua thanh vien dang nhap — FE dung quyet dinh hien menu
// "Thiet bi can duyet" va guard trang /dept-approval
async function getMyWorkshops(empNo) {
  if (!empNo) return [];
  const rows = await query(
    `SELECT u.l_code, bc.base_name
       FROM eqm_bas_user u
       LEFT JOIN dbo.bas_base_code bc
         ON bc.base_code = u.l_code AND bc.code_type = '176'
      WHERE u.emp_no = @e
      ORDER BY COALESCE(bc.base_name, u.l_code) ASC`,
    { e: empNo },
  );
  return rows.map((r) => ({ lCode: r.l_code, name: r.base_name || r.l_code }));
}

module.exports = {
  getMemberLCodes,
  isMemberOfLCode,
  lCodeExists,
  getGroupMembersMap,
  getGroupMembers,
  getFirstApproverMap,
  listLCodeOptions,
  getMyWorkshops,
};
