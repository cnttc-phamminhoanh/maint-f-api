// Ngày nghỉ bảo trì (2026-10-07, user chốt):
// - Thứ 7 vẫn đi làm; chỉ Chủ nhật + ngày trong hr_holiday là ngày nghỉ.
// - Ngày đến hạn bảo trì rơi vào ngày nghỉ -> dời sang ngày làm việc kế tiếp.
// - Cache Set ngày nghỉ trong memory (TTL 10 phút), refresh sau mỗi thao tác ghi.
// - Không có bảng/function (chưa chạy sql/003) thì tự vô hiệu, không chặn API.

const { query } = require('../db');
const { ApiError } = require('../errors');
const { addDays, fmtDate, getNextDueDay } = require('../utils/dates');

const TTL_MS = 10 * 60 * 1000;
const FAIL_RETRY_MS = 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let holidaySet = new Set();
let loadedAt = 0;
let loadingPromise = null;
let sqlShiftEnabled = false;

// 1900-01-01 là thứ Hai; khớp DATEDIFF(DAY,0,d) % 7 = 6 bên SQL.
function isSunday(dateStr) {
  const days = Math.round(
    (Date.parse(`${dateStr}T00:00:00Z`) - Date.parse('1900-01-01T00:00:00Z')) / 86400000,
  );
  return days % 7 === 6;
}

function shiftPastHolidays(dateStr) {
  if (!dateStr) return dateStr;
  let d = dateStr;
  let guard = 0;
  while ((isSunday(d) || holidaySet.has(d)) && guard < 60) {
    d = addDays(d, 1);
    guard += 1;
  }
  return d;
}

function getAdjustedDueDay(device) {
  return shiftPastHolidays(getNextDueDay(device));
}

async function detectHolidaySupport() {
  try {
    const rows = await query(
      'SELECT OBJECT_ID(\'dbo.fn_shift_due\') AS fnId',
    );
    sqlShiftEnabled = Boolean(rows.length > 0 && rows[0].fnId);
  } catch (err) {
    sqlShiftEnabled = false;
    console.error('[holiday] detect support failed:', err.message);
  }
  if (!sqlShiftEnabled) {
    console.warn('[holiday] fn_shift_due chưa tồn tại - chạy local-api/sql/003_hr_holiday.sql rồi restart.');
  }
}

function holidaySqlEnabled() {
  return sqlShiftEnabled;
}

async function loadHolidays() {
  const rows = await query('SELECT holiday_date FROM hr_holiday');
  // fmtDate: lay ngay theo gio HK, khong dung toISOString (UTC lui 1 ngay)
  holidaySet = new Set(rows.map((r) => fmtDate(r.holiday_date)));
}

// Load cache ngày nghỉ; lỗi (chưa tạo bảng) thì dùng Set rỗng, tự thử lại sau.
async function ensureHolidaysLoaded() {
  const now = Date.now();
  if (loadedAt > 0 && now - loadedAt < TTL_MS) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }
  loadingPromise = loadHolidays()
    .then(() => {
      loadedAt = Date.now();
    })
    .catch((err) => {
      loadedAt = now - TTL_MS + FAIL_RETRY_MS;
      console.error('[holiday] load hr_holiday failed:', err.message);
    })
    .finally(() => {
      loadingPromise = null;
    });
  await loadingPromise;
}

async function forceReload() {
  loadedAt = 0;
  loadingPromise = null;
  await ensureHolidaysLoaded();
}

async function listHolidays(year) {
  await ensureHolidaysLoaded();
  const rows = await query(
    `SELECT holiday_date, holiday_name FROM hr_holiday
     ${year ? 'WHERE YEAR(holiday_date) = @year' : ''}
     ORDER BY holiday_date`,
    year ? { year } : undefined,
  );
  return rows.map((r) => ({
    date: fmtDate(r.holiday_date),
    name: r.holiday_name || '',
  }));
}

// INSERT bỏ qua ngày đã tồn tại; trả về số dòng thực sự thêm.
async function createHolidays(items, empNo) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'items is required');
  }
  const seen = new Set();
  const clean = [];
  for (const item of items) {
    const date = String(item.date || '').slice(0, 10);
    if (!DATE_RE.test(date)) throw new ApiError(400, `Invalid date: ${item.date}`);
    if (seen.has(date)) continue;
    seen.add(date);
    clean.push({ date, name: String(item.name || '').slice(0, 200) });
  }
  if (clean.length === 0) throw new ApiError(400, 'items is empty');

  let inserted = 0;
  for (const item of clean) {
    // INSERT ... OUTPUT trả recordset -> dùng query(); NOT EXISTS chặn trùng.
    const out = await query(
      `INSERT INTO hr_holiday (holiday_date, holiday_name, created_emp_no)
       OUTPUT inserted.holiday_date
       SELECT @date, @name, @emp
       WHERE NOT EXISTS (SELECT 1 FROM hr_holiday WHERE holiday_date = @date)`,
      { date: item.date, name: item.name, emp: empNo || null },
    );
    inserted += out.length;
  }
  await forceReload();
  return { inserted, skipped: clean.length - inserted };
}

async function deleteHoliday(date) {
  const d = String(date || '').slice(0, 10);
  if (!DATE_RE.test(d)) throw new ApiError(400, `Invalid date: ${date}`);
  const out = await query(
    'DELETE FROM hr_holiday OUTPUT deleted.holiday_date WHERE holiday_date = @date',
    { date: d },
  );
  if (out.length === 0) throw new ApiError(404, 'Holiday not found');
  await forceReload();
  return { success: true };
}

module.exports = {
  detectHolidaySupport,
  holidaySqlEnabled,
  ensureHolidaysLoaded,
  isSunday,
  shiftPastHolidays,
  getAdjustedDueDay,
  listHolidays,
  createHolidays,
  deleteHoliday,
};
