const TIME_ZONE = 'Asia/Ho_Chi_Minh';

// 'YYYY-MM-DD' theo gio kinh doanh GMT+7
function businessToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function fmtDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// 'YYYY-MM-DD' + n ngay
function addDays(dateStr, days) {
  const ts = Date.parse(`${dateStr}T00:00:00Z`) + days * 86400000;
  return new Date(ts).toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  return Math.round(
    (Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / 86400000,
  );
}

// Cong thang/nam voi clamp ngay cuoi thang (khop voi DATEADD cua SQL Server).
// Vi du: 2026-01-31 + 1 thang = 2026-02-28
function addMonthsClamped(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTargetMonth);
  return `${targetYear}-${String(normalizedMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const CYCLE_MONTHS = { '1_month': 1, '1_year': 12 };

function getNextDueDay(device) {
  const base = fmtDate(device.lastMaintenanceDate) || fmtDate(device.startDate);
  if (!base) return null;
  const cycle = device.maintenanceCycle || device.maintenanceType || '1_month';
  if (cycle === '1_week') return addDays(base, 7);
  if (cycle === '2_weeks') return addDays(base, 14);
  return addMonthsClamped(base, CYCLE_MONTHS[cycle] || 1);
}

// Trang thai hien thi: giu nguyen 3 trang thai dac biet, con lai suy ra tu han bao tri
function effectiveStatus(row, today) {
  const raw = row.maintenanceStatus || row.maintenance_status;
  if (raw === 'in_maintenance' || raw === 'pending_approval' || raw === 'rejected') {
    return raw;
  }
  const nextDue = getNextDueDay({
    startDate: row.startDate || row.use_date,
    lastMaintenanceDate: row.lastMaintenanceDate || row.max_mt_date,
    maintenanceCycle: row.maintenanceCycle || row.maintenance_type,
  });
  if (!nextDue) return 'not_due';
  return nextDue <= today ? 'needs_maintenance' : 'not_due';
}

function isTempActive(row, today) {
  const tempDate = fmtDate(row.tempMaintainerDate || row.temp_maintainer_date);
  return Boolean(tempDate && tempDate === today);
}

// Nguoi phu trach hieu luc: temp chi co hieu luc trong ngay quet ma
function effectiveMaintainerEmpNo(row, today) {
  if (isTempActive(row, today)) {
    return row.tempMaintainerEmpNo || row.temp_maintainer_emp_no || null;
  }
  return row.maintainerEmpNo || row.maintainer_emp_no || null;
}

module.exports = {
  TIME_ZONE,
  businessToday,
  fmtDate,
  toIso,
  addDays,
  addMonthsClamped,
  daysBetween,
  getNextDueDay,
  effectiveStatus,
  isTempActive,
  effectiveMaintainerEmpNo,
};
