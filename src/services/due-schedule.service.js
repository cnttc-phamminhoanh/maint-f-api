/**
 * Tính hạn bảo dưỡng theo TỪNG THIẾT BỊ (2026-10-27 user chốt lại, BỎ hàng đợi
 * theo bộ phận cùng ngày): đúng thiết bị đúng ngày, không xếp lô/hàng đợi.
 * - Chu kỳ tuần (1_week / 2_weeks / 2_week): cộng đủ 7/14 ngày lịch rồi dời
 *   hạn thêm 1 ngày cho mỗi ngày Chủ nhật / hr_holiday rơi TRONG khoảng kỳ
 *   (vd bảo dưỡng 14/10 + 2 tuần = 28/10, có 2 CN 18/10 + 25/10 → hạn 30/10;
 *   lễ rơi giữa chừng lùi thêm). Ngày hạn cuối cùng luôn là ngày làm việc.
 * - Chu kỳ tháng/năm: ngày gốc + 1/12 tháng kẹp ngày cuối tháng; rơi ngày
 *   nghỉ thì trượt sang ngày làm việc kế.
 * Thiết bị ĐỎ = còn episode đỏ mở (redMap từ eqm_mnt_delay) — consumers đọc
 * redMap để giữ trạng thái/số ngày trễ liên mạch; pending_approval nằm ngoài
 * dueMap (ân hạn duyệt tính per-row trong computeCurrentDelayed).
 * Cache: TTL 60s + calendarVersion + invalidateSchedule() khi episode/duyệt đổi.
 */
const { query } = require('../db');
const { SUSPENDED_EPISODE_SQL } = require('./delayed.constants');
const holidayService = require('./holiday.service');
const {
  addDays,
  businessToday,
  hkDateStr,
  getNextDueDay,
} = require('../utils/dates');

const TTL_MS = 60 * 1000;

// số ngày lịch của chu kỳ tuần (CN + lễ trong kỳ được cộng bù vào hạn)
const WEEK_CYCLE_CALENDAR_DAYS = { '1_week': 7, '2_weeks': 14, '2_week': 14 };

function isWorkingDay(dateStr) {
  return !holidayService.isSunday(dateStr) && !holidayService.isHoliday(dateStr);
}

// cộng đủ số ngày lịch, rồi mỗi ngày nghỉ (CN/lễ) rơi trong khoảng kỳ dời hạn
// thêm 1 ngày — khoảng kỳ dài ra thì ngày nghỉ mới lại tiếp tục được tính
function addWeekCycleDays(base, calendarDays) {
  let due = addDays(base, calendarDays);
  let cursor = addDays(base, 1);
  while (cursor <= due) {
    if (!isWorkingDay(cursor)) due = addDays(due, 1);
    cursor = addDays(cursor, 1);
  }
  return due;
}

// Hạn theo (ngày gốc, chu kỳ) — nguồn duy nhất cho mọi nơi cần tính hạn đơn lẻ:
// tuần = +7/14 ngày lịch bù ngày nghỉ trong kỳ; tháng/năm = +tháng kẹp cuối tháng + dời ngày nghỉ
function computeDueFromBase(base, cycle) {
  if (!base) return null;
  const calendarDays = WEEK_CYCLE_CALENDAR_DAYS[cycle];
  if (calendarDays) return addWeekCycleDays(base, calendarDays);
  const rawDue = getNextDueDay({
    lastMaintenanceDate: base,
    startDate: base,
    maintenanceType: cycle,
  });
  return rawDue ? holidayService.shiftPastHolidays(rawDue) : null;
}

let scheduleCache = null;

async function buildSchedule(today) {
  await holidayService.ensureHolidaysLoaded();
  const rows = await query(
    `SELECT equ_no, use_date, max_mt_date, maintenance_type, maintenance_status
     FROM eqm_mnt`,
  );
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

  const dueMap = new Map();
  for (const row of rows) {
    if (row.maintenance_status === 'pending_approval') continue;
    const calendarDays = WEEK_CYCLE_CALENDAR_DAYS[row.maintenance_type];
    if (calendarDays) {
      const base = row.max_mt_date
        ? hkDateStr(row.max_mt_date)
        : hkDateStr(row.use_date);
      if (!base) continue;
      dueMap.set(row.equ_no, addWeekCycleDays(base, calendarDays));
      continue;
    }
    const rawDue = getNextDueDay({
      lastMaintenanceDate: row.max_mt_date,
      startDate: row.use_date,
      maintenanceType: row.maintenance_type,
    });
    if (!rawDue) continue;
    dueMap.set(row.equ_no, holidayService.shiftPastHolidays(rawDue));
  }
  return { map: dueMap, redMap, today };
}

async function getSchedule() {
  const today = businessToday();
  if (
    scheduleCache &&
    scheduleCache.today === today &&
    scheduleCache.calendarVersion === holidayService.getCalendarVersion() &&
    Date.now() - scheduleCache.builtAt < TTL_MS
  ) {
    return scheduleCache;
  }
  const built = await buildSchedule(today);
  scheduleCache = {
    ...built,
    builtAt: Date.now(),
    calendarVersion: holidayService.getCalendarVersion(),
  };
  return scheduleCache;
}

async function getEffectiveDueMap() {
  const s = await getSchedule();
  return s.map;
}

async function getRedDeviceMap() {
  const s = await getSchedule();
  return s.redMap;
}

function invalidateSchedule() {
  scheduleCache = null;
}

module.exports = {
  getEffectiveDueMap,
  getRedDeviceMap,
  invalidateSchedule,
  computeDueFromBase,
};
