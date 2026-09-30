const { query, queryOne, inClause } = require('../db');
const { toIso } = require('../utils/dates');

const FLAG_TO_SW = { 1: 'wk1_sw', 2: 'wk2_sw', 3: 'mon_sw', 4: 'year_sw' };
const CYCLE_TO_FLAG = { '1_week': '1', '2_weeks': '2', '1_month': '3', '1_year': '4' };

function cycleToMtFlag(cycle) {
  return CYCLE_TO_FLAG[cycle] || '3';
}

// Danh sach hang muc bao duong chuan theo loai thiet bi + chu ky.
// Gom nhom theo fit_no (SQL Server phien ban cu khong co STRING_AGG nen lam trong JS)
async function listTemplates(equType, mtFlag) {
  const swCol = FLAG_TO_SW[String(mtFlag)] || 'wk1_sw';
  const rows = await query(
    `SELECT id, equ_type, fit_no, fit_name, mt_desc, wk1_sw, wk2_sw, mon_sw, year_sw
     FROM eqm_bas_mt
     WHERE equ_type = @t AND ${swCol} = '1'
     ORDER BY fit_no ASC, mt_desc ASC`,
    { t: equType },
  );
  const byFitNo = new Map();
  for (const row of rows) {
    let group = byFitNo.get(row.fit_no);
    if (!group) {
      group = {
        id: row.id,
        fitName: row.fit_name,
        descs: [],
        wk1Sw: '0',
        wk2Sw: '0',
        monSw: '0',
        yearSw: '0',
      };
      byFitNo.set(row.fit_no, group);
    }
    if (Number(row.id) < Number(group.id)) group.id = row.id;
    if (group.fitName === null && row.fit_name) group.fitName = row.fit_name;
    if (row.mt_desc) group.descs.push(row.mt_desc);
    // MAX theo nhom (giong string_agg + max o cloud)
    if (row.wk1_sw > group.wk1Sw) group.wk1Sw = row.wk1_sw;
    if (row.wk2_sw > group.wk2Sw) group.wk2Sw = row.wk2_sw;
    if (row.mon_sw > group.monSw) group.monSw = row.mon_sw;
    if (row.year_sw > group.yearSw) group.yearSw = row.year_sw;
  }
  const items = [];
  for (const [fitNo, group] of byFitNo) {
    items.push({
      id: String(group.id),
      equType,
      fitNo,
      fitName: group.fitName,
      mtDesc: group.descs.join(' - '),
      wk1Sw: group.wk1Sw,
      wk2Sw: group.wk2Sw,
      monSw: group.monSw,
      yearSw: group.yearSw,
    });
  }
  return { items };
}

// Tra ve snapshot cac hang muc duoc chon (fitNo/fitName/mtDesc) de luu vao pending
async function resolveSelectedTemplates(equType, mtFlag, itemIds) {
  if (!itemIds || itemIds.length === 0) return [];
  const { items } = await listTemplates(equType, mtFlag);
  const selected = new Set(itemIds.map(String));
  return items
    .filter((item) => selected.has(item.id))
    .map((item) => ({ fitNo: item.fitNo, fitName: item.fitName, mtDesc: item.mtDesc }));
}

// Danh sach don bao duong cua thiet bi (theo equ_no).
// FIX(#3): lay items cua TAT CA don (IN ...), ban cu chi lay items cua don dau tien.
async function listOrdersByDevice(deviceId) {
  if (!/^\d+$/.test(String(deviceId))) {
    return { items: [] };
  }
  const device = await queryOne('SELECT equ_no FROM eqm_mnt WHERE id = @id', {
    id: deviceId,
  });
  const equNo = device ? device.equ_no : '';
  const orders = equNo
    ? await query(
      'SELECT * FROM eqm_mt1 WHERE equ_no = @e ORDER BY sheet_date DESC',
      { e: equNo },
    )
    : [];
  const itemsBySheet = new Map();
  if (orders.length > 0) {
    const sheetNos = orders.map((o) => o.sheet_no);
    const { sql: inSql, params } = inClause(sheetNos, 'sn');
    const itemRows = await query(
      `SELECT * FROM eqm_mt2 WHERE sheet_no IN (${inSql}) ORDER BY fit_no ASC`,
      params,
    );
    for (const item of itemRows) {
      const list = itemsBySheet.get(item.sheet_no) || [];
      list.push(item);
      itemsBySheet.set(item.sheet_no, list);
    }
  }
  const items = orders.map((order) => ({
    id: order.id,
    sheetNo: order.sheet_no,
    sheetType: order.sheet_type,
    sheetDate: toIso(order.sheet_date),
    deptNo: order.mnt_dept_no || '',
    empNo: order.emp_no || '',
    mtFlag: order.mt_flag || '',
    equNo: order.equ_no,
    rem: order.rem || '',
    createDate: toIso(order.create_date),
    checkDate: toIso(order.check_date),
    createUser: order.create_emp_no || '',
    checkUser: order.check_emp_no || '',
    sheetSta: order.sheet_sta || '',
    checkSta: order.check_sta || '',
    items: (itemsBySheet.get(order.sheet_no) || []).map((item) => ({
      id: item.id,
      sheetNo: item.sheet_no,
      fitNo: item.fit_no,
      fitName: item.fit_name || '',
      mtDesc: item.mt_desc || '',
      rem: item.rem || '',
    })),
  }));
  return { items };
}

module.exports = {
  FLAG_TO_SW,
  cycleToMtFlag,
  listTemplates,
  resolveSelectedTemplates,
  listOrdersByDevice,
};
