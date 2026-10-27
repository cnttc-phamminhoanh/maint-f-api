/**
 * Tính hạn bảo dưỡng theo TỪNG THIẾT BỊ (2026-10-27 user chốt lại, BỎ hàng đợi
 * theo bộ phận cùng ngày): đúng thiết bị đúng ngày, không xếp lô/hàng đợi.
 * - MỌI chu kỳ (tuần/tháng/năm): hạn gốc = ngày gốc + chu kỳ (tuần = 7/14 ngày
 *   lịch; tháng/năm = +1/12 tháng kẹp ngày cuối tháng), sau đó dời hạn thêm 1
 *   ngày cho mỗi Chủ nhật / hr_holiday rơi TRONG khoảng kỳ (ngày nghỉ mới phát
 *   sinh khi khoảng kỳ dài ra cũng được tính) — ngày hạn cuối luôn là ngày làm
 *   việc. Vd 14/10 + 2 tuần = 28/10, 2 CN 18/10 + 25/10 → 30/10;
 *   26/09 + 1 tháng = 26/10, 5 CN → 31/10.
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

// số ngày lịch của chu kỳ tuần (tháng/năm đi qua getNextDueDay)
const WEEK_CYCLE_CALENDAR_DAYS = { '1_week': 7, '2_weeks': 14, '2_week': 14 };

// hạn gốc (chưa bù ngày nghỉ) theo (ngày gốc, chu kỳ)
function rawDueFromBase(base, cycle) {
  const calendarDays = WEEK_CYCLE_CALENDAR_DAYS[cycle];
  if (calendarDays) return addDays(base, calendarDays);
  return getNextDueDay({
    lastMaintenanceDate: base,
    startDate: base,
    maintenanceType: cycle,
  });
}

// Hạn theo (ngày gốc, chu kỳ) — nguồn duy nhất: hạn gốc + cộng bù mọi ngày nghỉ
// rơi trong khoảng kỳ (tuần/tháng/năm dùng chung một luật)
function computeDueFromBase(base, cycle) {
  if (!base) return null;
  const rawDue = rawDueFromBase(base, cycle);
  return rawDue ? holidayService.shiftDueByRestDaysInPeriod(base, rawDue) : null;
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
  const allDueMap = new Map();
  for (const row of rows) {
    const base = row.max_mt_date
      ? hkDateStr(row.max_mt_date)
      : hkDateStr(row.use_date);
    if (!base) continue;
    const due = computeDueFromBase(base, row.maintenance_type);
    if (!due) continue;
    allDueMap.set(row.equ_no, due);
    if (row.maintenance_status !== 'pending_approval') dueMap.set(row.equ_no, due);
  }
  return { map: dueMap, allMap: allDueMap, redMap, today };
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

// includePending: tab Hom nay / Ngay mai + ngay han tren card phai hien dung
// moi trang thai (ke ca cho xet duyet); cac thong ke "dang tre" giu ban loai pending
async function getEffectiveDueMap(includePending = false) {
  const s = await getSchedule();
  return includePending ? s.allMap : s.map;
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
