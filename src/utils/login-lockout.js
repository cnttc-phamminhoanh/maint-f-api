const { query, queryOne } = require('../db');
const { ApiError } = require('../errors');
const config = require('../config');

async function getLock(empNo) {
  return queryOne('SELECT fail_count, locked_until FROM emp_mnt_login_lock WHERE emp_no = @e', {
    e: empNo,
  });
}

async function upsertLock(empNo, failCount, lockedUntil) {
  // MERGE khong co OUTPUT -> khong co recordset, phai dung query()
  await query(
    `MERGE emp_mnt_login_lock AS t
     USING (SELECT @e AS emp_no) AS s ON t.emp_no = s.emp_no
     WHEN MATCHED THEN UPDATE SET fail_count = @f, locked_until = @l
     WHEN NOT MATCHED THEN INSERT (emp_no, fail_count, locked_until) VALUES (@e, @f, @l);`,
    { e: empNo, f: failCount, l: lockedUntil },
  );
}

// Goi TRUOC khi xac thuc PIN / khuon mat
async function assertNotLocked(empNo) {
  const lock = await getLock(empNo);
  if (lock && lock.locked_until && new Date(lock.locked_until).getTime() > Date.now()) {
    const minutes = Math.ceil((new Date(lock.locked_until).getTime() - Date.now()) / 60000);
    throw new ApiError(429, `ACCOUNT_LOCKED:${minutes}`);
  }
}

// Dang nhap that bai (PIN sai / khuon mat khong khop)
async function recordFailure(empNo) {
  const lock = await getLock(empNo);
  const count = (lock ? lock.fail_count : 0) + 1;
  const lockedUntil =
    count >= config.pinMaxAttempts
      ? new Date(Date.now() + config.pinLockMinutes * 60000)
      : null;
  await upsertLock(empNo, lockedUntil ? 0 : count, lockedUntil);
  return { locked: Boolean(lockedUntil) };
}

// Dang nhap thanh cong
async function resetAttempts(empNo) {
  // MERGE khong co OUTPUT -> khong co recordset, phai dung query()
  await query(
    `MERGE emp_mnt_login_lock AS t
     USING (SELECT @e AS emp_no) AS s ON t.emp_no = s.emp_no
     WHEN MATCHED THEN UPDATE SET fail_count = 0, locked_until = NULL;`,
    { e: empNo },
  );
}

module.exports = { assertNotLocked, recordFailure, resetAttempts };
