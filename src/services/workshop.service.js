const { query, queryOne } = require('../db');

// Phan xuong (xuong_mnt): moi xuong co toi da 3 thanh vien
// (chu quan xuong + pho chu quan 1 + pho chu quan 2).
// eqm_mnt.approver_emp_no chua ma phan xuong; xet duyet gui cho
// tat ca thanh vien cua phan xuong do (2026-10-09).

async function getMemberXuongNos(empNo) {
  if (!empNo) return [];
  const rows = await query(
    `SELECT xuong_no FROM xuong_mnt
      WHERE chu_quan_emp_no = @e OR pho_quan_1_emp_no = @e OR pho_quan_2_emp_no = @e
      ORDER BY xuong_no ASC`,
    { e: empNo },
  );
  return rows.map((r) => r.xuong_no);
}

async function isMemberOfXuong(empNo, xuongNo) {
  if (!empNo || !xuongNo) return false;
  const row = await queryOne(
    `SELECT TOP 1 xuong_no FROM xuong_mnt
      WHERE xuong_no = @x
        AND (chu_quan_emp_no = @e OR pho_quan_1_emp_no = @e OR pho_quan_2_emp_no = @e)`,
    { x: xuongNo, e: empNo },
  );
  return Boolean(row);
}

async function getXuong(xuongNo) {
  if (!xuongNo) return null;
  return queryOne(
    'SELECT xuong_no, xuong_name, chu_quan_emp_no FROM xuong_mnt WHERE xuong_no = @x',
    { x: xuongNo },
  );
}

// Map ma phan xuong -> {xuongNo, xuongName, headEmpNo} (chu quan xuong)
async function getXuongHeadMap(codes) {
  const map = new Map();
  if (!codes || codes.length === 0) return map;
  const params = {};
  const placeholders = codes.map((c, i) => {
    params[`x${i}`] = c;
    return `@x${i}`;
  });
  const rows = await query(
    `SELECT xuong_no, xuong_name, chu_quan_emp_no FROM xuong_mnt
      WHERE xuong_no IN (${placeholders.join(',')})`,
    params,
  );
  for (const r of rows) {
    map.set(r.xuong_no, {
      xuongNo: r.xuong_no,
      xuongName: r.xuong_name || '',
      headEmpNo: r.chu_quan_emp_no || '',
    });
  }
  return map;
}

async function listAllXuong() {
  // 2026-10-10: ten phan xuong lay tu bas_dept.dept_name (xuong_no = dept_no)
  return query(
    `SELECT x.xuong_no, x.xuong_name, x.chu_quan_emp_no, e.emp_name,
            bd.dept_name AS xuong_dept_name
      FROM xuong_mnt x
      LEFT JOIN emp_mnt e ON e.emp_no = x.chu_quan_emp_no
      LEFT JOIN dbo.bas_dept bd ON bd.dept_no = x.xuong_no
      ORDER BY x.xuong_no ASC`,
  );
}

async function getMyWorkshops(empNo) {
  if (!empNo) return [];
  const rows = await query(
    `SELECT xuong_no, xuong_name, chu_quan_emp_no, pho_quan_1_emp_no, pho_quan_2_emp_no
      FROM xuong_mnt
      WHERE chu_quan_emp_no = @e OR pho_quan_1_emp_no = @e OR pho_quan_2_emp_no = @e
      ORDER BY xuong_no ASC`,
    { e: empNo },
  );
  return rows.map((r) => ({
    xuongNo: r.xuong_no,
    xuongName: r.xuong_name || '',
    role: r.chu_quan_emp_no === empNo
      ? 'chu_quan'
      : r.pho_quan_1_emp_no === empNo
        ? 'pho_quan_1'
        : 'pho_quan_2',
  }));
}

module.exports = {
  getMemberXuongNos,
  isMemberOfXuong,
  getXuong,
  getXuongHeadMap,
  listAllXuong,
  getMyWorkshops,
};
