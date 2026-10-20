const crypto = require('crypto');
const { query, queryOne, withTransaction, txQuery } = require('../db');
const { ApiError } = require('../errors');
const config = require('../config');
const { resolveByEmpNo, toPublicUser } = require('../utils/auth');
const { createSession, destroyUserSessions } = require('../utils/session');
const { getRemainingLockMinutes, recordFailure, resetAttempts } = require('../utils/login-lockout');

// Cua so truot trong bo nho chan do mat khau dang ky
const registerAttempts = [];

function assertRegisterNotBruteForced() {
  const cutoff = Date.now() - config.registerWindowMinutes * 60000;
  while (registerAttempts.length > 0 && registerAttempts[0] < cutoff) registerAttempts.shift();
  if (registerAttempts.length >= config.registerMaxAttempts) {
    throw new ApiError(429, `REGISTER_LOCKED:${config.registerWindowMinutes}`);
  }
  registerAttempts.push(Date.now());
}

// Cua so truot rieng chan TAO TAI KHOAN hang loat (ke ca khi da co dung mat khau)
const registerCreateAttempts = [];

function assertRegisterNotSpammed() {
  const cutoff = Date.now() - config.registerWindowMinutes * 60000;
  while (registerCreateAttempts.length > 0 && registerCreateAttempts[0] < cutoff) {
    registerCreateAttempts.shift();
  }
  if (registerCreateAttempts.length >= config.registerMaxAttempts) {
    throw new ApiError(429, `REGISTER_LOCKED:${config.registerWindowMinutes}`);
  }
  registerCreateAttempts.push(Date.now());
}

const SCRYPT_KEYLEN = 64;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function lookupUser(empNo) {
  if (!empNo) throw new ApiError(400, 'empNo is required');
  const row = await queryOne('SELECT * FROM emp_mnt WHERE emp_no = @e', { e: empNo });
  if (!row) return { exists: false };
  return { exists: true, user: toPublicUser(row) };
}

async function getUserStatus(empNo) {
  const row = await resolveByEmpNo(empNo);
  if (!row) throw new ApiError(404, 'User not found');
  return toPublicUser(row);
}

async function updateUserProfile(empNo, empName, avatarUrl) {
  const row = await resolveByEmpNo(empNo);
  if (!row) throw new ApiError(404, 'User not found');
  const updated = await queryOne(
    'UPDATE emp_mnt SET emp_name = @n, avatar_url = @a OUTPUT inserted.* WHERE id = @id',
    { n: empName, a: avatarUrl === undefined ? row.avatar_url : avatarUrl, id: row.id },
  );
  return toPublicUser(updated);
}

// 2026-10-20: đăng ký tài khoản kèm position; 3 position này bắt buộc chọn bộ phận
const DEPT_POSITIONS = ['chu_quan', 'nhan_vien_bao_tri', 'van_thu'];

async function getAllowedPositions() {
  const rows = await query(
    `SELECT DISTINCT position FROM emp_mnt
      WHERE position NOT IN ('', 'admin', 'hr')
      ORDER BY position ASC`,
  );
  return rows.map((r) => r.position);
}

async function getRegisterOptions() {
  const [positions, departments, locations] = await Promise.all([
    getAllowedPositions(),
    query(
      `SELECT DISTINCT mnt_dept_no, mnt_dept_name FROM dept_mnt
        ORDER BY mnt_dept_no ASC`,
    ),
    query(
      `SELECT DISTINCT base_code, base_name FROM bas_base_code
        WHERE code_type = '176'
        ORDER BY base_code ASC`,
    ),
  ]);
  return {
    positions,
    departments: departments.map((d) => ({
      code: d.mnt_dept_no,
      name: d.mnt_dept_name || d.mnt_dept_no,
    })),
    locations: locations.map((l) => ({
      code: l.base_code,
      name: l.base_name || l.base_code,
    })),
  };
}

async function registerUser(empNo, empName, accessPassword, details) {
  // Chặn đăng ký hàng loạt: giới hạn số lần tạo + bắt buộc đúng mật khẩu mở đăng ký
  assertRegisterNotSpammed();
  if (!accessPassword || accessPassword !== config.registerPassword) {
    throw new ApiError(403, 'Invalid access password');
  }
  const extra = details || {};
  const position = String(extra.position || '').trim();
  const allowedPositions = await getAllowedPositions();
  if (!allowedPositions.includes(position)) {
    throw new ApiError(400, 'Invalid position');
  }
  let deptNo = null;
  if (DEPT_POSITIONS.includes(position)) {
    deptNo = String(extra.mntDeptNo || '').trim() || null;
    if (!deptNo) throw new ApiError(400, 'Department required for this position');
    const dept = await queryOne(
      'SELECT TOP 1 mnt_dept_no FROM dept_mnt WHERE mnt_dept_no = @d',
      { d: deptNo },
    );
    if (!dept) throw new ApiError(400, 'Department not found');
  }
  let location = null;
  if (position === 'approver') {
    location = String(extra.location || '').trim() || null;
    if (!location) throw new ApiError(400, 'Location required for approver');
    const loc = await queryOne(
      `SELECT TOP 1 base_code FROM bas_base_code
        WHERE base_code = @l AND code_type = '176'`,
      { l: location },
    );
    if (!loc) throw new ApiError(400, 'Location not found');
  }
  const existing = await queryOne('SELECT id FROM emp_mnt WHERE emp_no = @e', { e: empNo });
  if (existing) throw new ApiError(409, 'MNV da ton tai');
  const values = { e: empNo, n: empName || empNo, p: position, d: deptNo, l: location };
  let created;
  try {
    await withTransaction(async (tx) => {
      const rows = await txQuery(
        tx,
        `INSERT INTO emp_mnt (emp_no, emp_name, pin_hash, face_image_url, position, mnt_dept_no)
         OUTPUT inserted.*
         VALUES (@e, @n, '', '', @p, @d)`,
        values,
      );
      created = rows[0];
      if (position === 'approver' && location) {
        const dup = await txQuery(
          tx,
          'SELECT TOP 1 l_code FROM eqm_bas_user WHERE l_code = @l AND emp_no = @e',
          values,
        );
        if (dup.length === 0) {
          await txQuery(
            tx,
            `INSERT INTO eqm_bas_user (l_code, emp_no, emp_name, wc_name, wc_id)
             VALUES (@l, @e, @n, NULL, NULL)`,
            values,
          );
        }
      }
    });
  } catch (err) {
    const num = err && (err.number || (err.originalError && err.originalError.number));
    if (num === 2627 || num === 2601) throw new ApiError(409, 'MNV da ton tai');
    throw err;
  }
  return toPublicUser(created);
}

async function setupPin(empNo, pin) {
  const row = await resolveByEmpNo(empNo);
  if (!row) throw new ApiError(404, 'User not found');
  if (row.pin_hash) throw new ApiError(400, 'PIN already set');
  await query('UPDATE emp_mnt SET pin_hash = @p WHERE id = @id', {
    p: hashPin(pin),
    id: row.id,
  });
  return { success: true };
}

async function verifyPinLogin(empNo, pin) {
  const row = await resolveByEmpNo(empNo);
  if (!row) throw new ApiError(404, 'User not found');
  const lockMinutes = await getRemainingLockMinutes(row.emp_no);
  if (lockMinutes > 0) {
    return { success: false, errorCode: 'ACCOUNT_LOCKED', lockMinutes };
  }
  if (!verifyPin(pin, row.pin_hash)) {
    const lock = await recordFailure(row.emp_no);
    if (lock.locked) {
      return { success: false, errorCode: 'ACCOUNT_LOCKED', lockMinutes: config.pinLockMinutes };
    }
    return { success: false, errorCode: 'WRONG_PIN', remainingAttempts: lock.remaining };
  }
  await resetAttempts(row.emp_no);
  const session = await createSession(row.emp_no);
  return {
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    userId: row.emp_no,
    empNo: row.emp_no,
    empName: row.emp_name,
    position: row.position || '',
    avatarUrl: row.avatar_url || '',
  };
}

async function changePin(empNo, currentPin, newPin) {
  const row = await resolveByEmpNo(empNo);
  if (!row) throw new ApiError(404, 'User not found');
  if (!row.pin_hash) return { success: false, errorCode: 'PIN_NOT_SET' };
  if (!verifyPin(currentPin, row.pin_hash)) {
    return { success: false, errorCode: 'WRONG_CURRENT_PIN' };
  }
  await query('UPDATE emp_mnt SET pin_hash = @p WHERE id = @id', {
    p: hashPin(newPin),
    id: row.id,
  });
  // Doi PIN: thu hoi toan bo phien cu, buoc dang nhap lai tren moi thiet bi
  await destroyUserSessions(row.emp_no);
  return { success: true };
}

async function checkRegisterAccess(password) {
  assertRegisterNotBruteForced();
  if (!config.registerPassword) return { ok: false };
  if (password !== config.registerPassword) {
    return { ok: false };
  }
  return { ok: true };
}

async function listUsers(position) {
  const where = position ? 'WHERE position = @p' : '';
  const params = position ? { p: position } : undefined;
  const rows = await query(`SELECT * FROM emp_mnt ${where} ORDER BY emp_name`, params);
  return { items: rows.map((r) => toPublicUser(r)) };
}

module.exports = {
  hashPin,
  lookupUser,
  getUserStatus,
  updateUserProfile,
  registerUser,
  setupPin,
  verifyPinLogin,
  changePin,
  checkRegisterAccess,
  getRegisterOptions,
  listUsers,
};
