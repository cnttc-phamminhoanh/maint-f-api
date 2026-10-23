// Lịch hạn bảo dưỡng trượt chuyền (2026-10-23, user chốt):
// Hạn gốc (max_mt_date ?? use_date + chu kỳ) rơi vào ngày nghỉ (Chủ nhật + hr_holiday;
// thứ 7 vẫn đi làm) KHÔNG gộp vào ngày kế (cách cũ làm việc chồng chất) mà TRƯỢT CHUYỂN
// DÂY CHUYỀN:
//   - Mẻ thiết bị rơi ngày nghỉ được đẩy sang ngày kế tiếp;
//   - Nếu ngày nhận đã có mẻ riêng, mẻ đó lại bị đẩy tiếp 1 ngày, cứ thế;
//   - Mỗi ngày làm việc chỉ nhận MỘT mẻ đến sớm nhất;
//   - Chuỗi dừng ở ngày đầu tiên không có mẻ nào đến hạn (ngày đó hấp thu mẻ tới).
// => Hạn của từng thiết bị phụ thuộc toàn bộ lịch, phải tính gộp tất cả thiết bị
// (không thể per-row như fn_shift_due cũ).
// Cache: TTL 60s + calendarVersion (hr_holiday nạp lại) + invalidateSchedule() khi
// duyệt hoàn thành đổi max_mt_date. Ngày nghiệp vụ theo Asia/Ho_Chi_Minh.

const { query } = require('../db');
const { getNextDueDay, addDays } = require('../utils/dates');
const holidayService = require('./holiday.service');

const TTL_MS = 60 * 1000;
const MAX_ITERATIONS = 200000;

let cache = null; // { map: Map<equNo, dueStr>, builtAt, calendarVersion }

function isRestDay(dateStr) {
  return holidayService.isSunday(dateStr) || holidayService.isHoliday(dateStr);
}

// rows: { equ_no, use_date, max_mt_date, maintenance_type }
function buildEffectiveDueMap(rows) {
  const byDate = new Map(); // hạn gốc -> [equNo, ...]
  for (const row of rows) {
    const due = getNextDueDay({
      startDate: row.use_date,
      lastMaintenanceDate: row.max_mt_date,
      maintenanceCycle: row.maintenance_type,
    });
    if (!due) continue;
    const batch = byDate.get(due);
    if (batch) batch.push(row.equ_no);
    else byDate.set(due, [row.equ_no]);
  }
  const effective = new Map(); // equNo -> hạn trượt chuyền
  if (byDate.size === 0) return effective;

  const dates = [...byDate.keys()].sort();
  const carry = []; // FIFO mẻ bị đẩy tiếp, đầu hàng = mẻ đến sớm nhất
  let cursor = dates[0];
  let di = 0;
  let guard = 0;
  while ((di < dates.length || carry.length > 0) && guard < MAX_ITERATIONS) {
    guard += 1;
    if (carry.length === 0 && cursor < dates[di]) cursor = dates[di];
    const own = byDate.get(cursor);
    if (own) di += 1;
    if (isRestDay(cursor)) {
      if (own) carry.push(own);
    } else if (carry.length > 0) {
      const batch = carry.shift();
      for (const equNo of batch) effective.set(equNo, cursor);
      if (own) carry.push(own); // mẻ riêng của ngày này bị đẩy tiếp
    } else if (own) {
      for (const equNo of own) effective.set(equNo, cursor); // không có chuỗi: giữ nguyên ngày
    }
    cursor = addDays(cursor, 1);
  }
  return effective;
}

async function getEffectiveDueMap() {
  const version = holidayService.getCalendarVersion();
  if (
    cache &&
    cache.calendarVersion === version &&
    Date.now() - cache.builtAt < TTL_MS
  ) {
    return cache.map;
  }
  await holidayService.ensureHolidaysLoaded();
  const rows = await query(
    'SELECT equ_no, use_date, max_mt_date, maintenance_type FROM eqm_mnt',
  );
  const map = buildEffectiveDueMap(rows);
  cache = {
    map,
    builtAt: Date.now(),
    calendarVersion: holidayService.getCalendarVersion(),
  };
  return map;
}

function invalidateSchedule() {
  cache = null;
}

module.exports = { getEffectiveDueMap, invalidateSchedule };
