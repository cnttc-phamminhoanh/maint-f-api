/**
 * Hàng đợi hạn bảo dưỡng theo bộ phận (chốt 2026-10-27, thay cascade 23/10):
 * - Mỗi bộ phận (mnt_dept_no) có một hàng đợi việc, mỗi ngày làm việc một lô:
 *   lô có hạn gốc cũ nhất chưa bảo dưỡng = việc «Hôm nay»; các lô sau xếp lần
 *   lượt vào các ngày làm việc kế tiếp (nghỉ = Chủ nhật + hr_holiday, thứ 7
 *   vẫn làm). Hạn gốc trong tương lai giữ nguyên vị trí (không bị kéo sớm
 *   hơn chính nó; nếu ngày đó là ngày nghỉ thì trượt sang ngày làm việc kế).
 * - Hàng đợi neo từ QUEUE_RULE_START: backlog quá hạn trước ngày luật mới hiệu
 *   lực xếp hàng lại từ đầu (lô cũ nhất = QUEUE_RULE_START) nên KHÔNG bị tính
 *   trễ ngay — chỉ khi ngày làm việc của lô trôi qua mà vẫn chưa bảo dưỡng thì
 *   cron runSync mới mở episode đỏ (ngày hôm sau settle < today).
 * - Thiết bị ĐỎ = còn episode đỏ mở (lưu trong redMap, loại khỏi hàng đợi);
 *   thiết bị pending_approval không nằm trong hàng đợi lẫn redMap (luật ân hạn
 *   awaiting riêng). Bảo dưỡng xong / duyệt xong episode đóng -> thiết bị quay
 *   lại hàng đợi với hạn gốc mới, tự xếp lại từ hôm nay.
 * - Hạn hiển thị của lô đang xếp hàng = ngày làm việc được xếp (có thể LỚN hơn
 *   hạn gốc — đó là bản chất giãn backlog). FE/API đọc settle date, không tự tính.
 * Cache: TTL 60s + calendarVersion + invalidateSchedule() khi episode/duyệt thay đổi.
 */
const { query } = require('../db');
// eslint-disable-next-line no-unused-vars
const config = require('../config');
const { SUSPENDED_EPISODE_SQL } = require('./delayed.constants');
const holidayService = require('./holiday.service');
const {
  businessToday,
  addDays,
  hkDateStr,
  getNextDueDay,
} = require('../utils/dates');

// Ngày luật hàng đợi hiệu lực: backlog quá hạn trước ngày này xếp hàng lại từ đây
const QUEUE_RULE_START = '2026-10-27';

let scheduleCache = null;

async function buildSchedule() {
  const today = businessToday();
  await holidayService.ensureHolidaysLoaded();
  const rows = await query(
    `SELECT equ_no, use_date, max_mt_date, maintenance_type, maintenance_status, mnt_dept_no
     FROM eqm_mnt`,
  );
  // Episode đỏ đang mở (không tính dòng "treo" của thiết bị pending và dòng
  // awaiting_approval): những thiết bị này đang trễ, loại khỏi hàng đợi
  const redRows = await query(
    `SELECT d.equ_no, d.next_due_date,
            DATEDIFF(day, d.next_due_date, CAST(@today AS date)) AS days_overdue
     FROM eqm_mnt_delay d
     WHERE d.resolved_at IS NULL AND d.reason <> 'awaiting_approval' AND ${SUSPENDED_EPISODE_SQL}`,
    { today },
  );
  const redMap = new Map();
  for (const r of redRows) {
    redMap.set(r.equ_no, {
      due: hkDateStr(r.next_due_date),
      daysOverdue: r.days_overdue,
    });
  }

  const byDept = new Map();
  for (const row of rows) {
    if (row.maintenance_status === 'pending_approval') continue;
    if (redMap.has(row.equ_no)) continue;
    const base = row.max_mt_date || row.use_date;
    if (!base) continue;
    const rawDue = getNextDueDay({
      lastMaintenanceDate: row.max_mt_date,
      startDate: row.use_date,
      maintenanceType: row.maintenance_type,
    });
    const shifted = holidayService.shiftPastHolidays(rawDue);
    const dept = row.mnt_dept_no || '';
    const list = byDept.get(dept) || [];
    list.push({ equNo: row.equ_no, due: shifted });
    byDept.set(dept, list);
  }

  const dueMap = new Map();
  for (const list of byDept.values()) {
    list.sort((a, b) =>
      a.due < b.due ? -1 : a.due > b.due ? 1 : a.equNo < b.equNo ? -1 : 1);
    // Neo hàng đợi: ngày bắt đầu = muộn hơn giữa (ngày luật, hạn lô cũ nhất)
    let cursor = holidayService.shiftPastHolidays(
      list[0].due > QUEUE_RULE_START ? list[0].due : QUEUE_RULE_START,
    );
    for (const item of list) {
      const day = item.due > cursor ? item.due : cursor;
      const settle = holidayService.shiftPastHolidays(day);
      dueMap.set(item.equNo, settle);
      let next = addDays(settle, 1);
      while (holidayService.isSunday(next) || holidayService.isHoliday(next)) {
        next = addDays(next, 1);
      }
      cursor = next;
    }
  }
  return { map: dueMap, redMap, today };
}

function cacheValid() {
  if (!scheduleCache) return false;
  if (scheduleCache.today !== businessToday()) return false;
  if (scheduleCache.calendarVersion !== holidayService.calendarVersion()) return false;
  if (Date.now() - scheduleCache.builtAt > 60_000) return false;
  return true;
}

async function getSchedule() {
  if (cacheValid()) return scheduleCache;
  scheduleCache = {
    ...(await buildSchedule()),
    calendarVersion: holidayService.calendarVersion(),
    builtAt: Date.now(),
  };
  return scheduleCache;
}

// Hạn trượt của thiết bị trong hàng đợi; thiết bị đỏ / pending -> undefined
async function getEffectiveDueMap() {
  return (await getSchedule()).map;
}

// equ_no -> { due, daysOverdue } của các thiết bị đang trễ (episode đỏ mở)
async function getRedDeviceMap() {
  return (await getSchedule()).redMap;
}

function invalidateSchedule() {
  scheduleCache = null;
}

module.exports = {
  QUEUE_RULE_START,
  getEffectiveDueMap,
  getRedDeviceMap,
  invalidateSchedule,
};
