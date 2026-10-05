const crypto = require('crypto');
const { query, queryOne } = require('../db');
const config = require('../config');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Phien hop le: tra ve row emp_mnt; het han / khong ton tai: null (dong thoi don dep phien het han)
async function getSession(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT TOP 1 e.id, e.emp_no, e.position, e.mnt_dept_no
     FROM emp_mnt_session s JOIN emp_mnt e ON e.emp_no = s.emp_no
     WHERE s.token_hash = @h AND s.expires_at > GETDATE()`,
    { h: hashToken(token) },
  );
  if (!row) {
    query('DELETE FROM emp_mnt_session WHERE expires_at <= GETDATE()').catch(() => {});
  }
  return row;
}

async function createSession(empNo) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400000);
  await query(
    'INSERT INTO emp_mnt_session (token_hash, emp_no, expires_at) VALUES (@h, @e, @x)',
    { h: hashToken(token), e: empNo, x: expiresAt },
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM emp_mnt_session WHERE token_hash = @h', { h: hashToken(token) });
}

// Thu hoi toan bo phien cua mot nhan vien (doi PIN, khoa tai khoan...)
async function destroyUserSessions(empNo) {
  await query('DELETE FROM emp_mnt_session WHERE emp_no = @e', { e: empNo });
}

module.exports = { hashToken, getSession, createSession, destroySession, destroyUserSessions };
