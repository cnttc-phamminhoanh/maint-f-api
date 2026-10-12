const { query, queryOne, inClause } = require('../db');
const { ApiError } = require('../errors');
const { toIso } = require('../utils/dates');
const fcm = require('./fcm');

const MAX_ERROR_LEN = 500;

const DISPATCH_TITLES = {
  submitted: 'Yêu cầu xét duyệt',
  approved: 'Đã duyệt hoàn thành',
  rejected: 'Đơn bị từ chối',
};

// ==== Dang ky / quan ly token ====

// MERGE khong sinh recordset -> dung query() thuong, khong duoc dung queryOne
async function registerToken(empNo, token, deviceLabel) {
  await query(
    `MERGE emp_push_token AS t
     USING (SELECT 1) AS s ON t.fcm_token = @token
     WHEN MATCHED THEN
       UPDATE SET emp_no = @empNo, is_active = 1,
                  last_seen_at = GETDATE(), device_label = @label
     WHEN NOT MATCHED THEN
       INSERT (emp_no, fcm_token, device_label, is_active, created_at, last_seen_at)
       VALUES (@empNo, @token, @label, 1, GETDATE(), GETDATE());`,
    { empNo, token, label: deviceLabel || null },
  );
}

async function unregisterToken(empNo, token) {
  await query(
    'UPDATE emp_push_token SET is_active = 0 WHERE fcm_token = @token AND emp_no = @empNo',
    { empNo, token },
  );
}

async function listTokens() {
  const rows = await query(
    `SELECT t.id, t.emp_no, t.fcm_token, t.device_label, t.is_active,
            t.created_at, t.last_seen_at, e.emp_name
     FROM emp_push_token t
     LEFT JOIN emp_mnt e ON e.emp_no = t.emp_no
     ORDER BY t.last_seen_at DESC`,
  );
  const items = rows.map((r) => ({
    id: r.id,
    empNo: r.emp_no,
    empName: r.emp_name || '',
    fcmToken: r.fcm_token,
    deviceLabel: r.device_label || '',
    isActive: !!r.is_active,
    createdAt: toIso(r.created_at),
    lastSeenAt: toIso(r.last_seen_at),
  }));
  return { items };
}

async function toggleToken(id, isActive) {
  const updated = await query(
    'UPDATE emp_push_token SET is_active = @isActive OUTPUT inserted.id WHERE id = @id',
    { id, isActive: isActive ? 1 : 0 },
  );
  if (updated.length === 0) throw new ApiError(404, 'Token not found');
  return { success: true };
}

// ==== Nhat ky gui ====

async function listLog(page, pageSize) {
  const totalRows = await query('SELECT COUNT(*) AS total FROM push_log');
  const total = totalRows[0] ? totalRows[0].total : 0;
  const offset = (page - 1) * pageSize;
  const rows = await query(
    `SELECT id, event_type, equ_no, actor_emp_no, recipient_emp_no, status, error, created_at
     FROM push_log
     ORDER BY created_at DESC, id DESC
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { offset, pageSize },
  );
  const items = rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    equNo: r.equ_no || '',
    actorEmpNo: r.actor_emp_no || '',
    recipientEmpNo: r.recipient_emp_no,
    status: r.status,
    error: r.error || '',
    createdAt: toIso(r.created_at),
  }));
  return { items, total, page, pageSize };
}

// Nhieu dong push_log trong 1 statement, created_at = dong ho server DB
async function insertLogRows(entries) {
  if (entries.length === 0) return;
  const valueParts = [];
  const params = {};
  entries.forEach((e, i) => {
    valueParts.push(`(@e${i}, @q${i}, @a${i}, @r${i}, @s${i}, @err${i}, GETDATE())`);
    params[`e${i}`] = e.eventType;
    params[`q${i}`] = e.equNo || null;
    params[`a${i}`] = e.actorEmpNo || null;
    params[`r${i}`] = e.recipientEmpNo;
    params[`s${i}`] = e.status;
    params[`err${i}`] = e.error ? String(e.error).slice(0, MAX_ERROR_LEN) : null;
  });
  await query(
    `INSERT INTO push_log (event_type, equ_no, actor_emp_no, recipient_emp_no, status, error, created_at)
     VALUES ${valueParts.join(', ')}`,
    params,
  );
}

// ==== Gui ====

async function sendTest(empNo) {
  if (!fcm.isPushEnabled()) {
    throw new ApiError(400, 'Push chưa được cấu hình (FIREBASE_SERVICE_ACCOUNT)');
  }
  const tokenRows = await query(
    'SELECT fcm_token FROM emp_push_token WHERE is_active = 1 AND emp_no = @empNo',
    { empNo },
  );
  const tokens = tokenRows.map((r) => r.fcm_token);
  const { results } = await fcm.sendMulticast(tokens, {
    title: 'Thông báo thử',
    body: 'Đây là thông báo thử từ hệ thống bảo dưỡng thiết bị.',
    data: { url: '/' },
  });
  await insertLogRows(results.map((r) => ({
    eventType: 'test',
    equNo: null,
    actorEmpNo: empNo,
    recipientEmpNo: empNo,
    status: r.ok ? 'sent' : 'failed',
    error: r.ok ? '' : (r.errorMessage || r.errorCode || 'unknown'),
  })));
  return { success: true, sent: results.filter((r) => r.ok).length };
}

function buildBody(type, actorName, equName, equNo) {
  const name = actorName || 'Người dùng';
  const device = `${equName} (${equNo})`;
  if (type === 'submitted') return `${name} vừa gửi xét duyệt ${device}`;
  if (type === 'approved') return `${name} đã xác nhận hoàn thành ${device}`;
  return `${name} đã từ chối ${device}`;
}

// Nhom duyet cua thiet bi -> Map(empNo -> url nhan thong bao).
// Luu y: eqm_mnt.approver_emp_no tu 2026-10-09 la MA PHAN XUONG (xuong_mnt.xuong_no),
// nen phia approver lay chu quan + 2 pho quan cua phan xuong do; truoc day la MNV.
async function collectRecipients(deviceRow, actorEmpNo, type) {
  const recipients = new Map();
  const add = (empNo, url) => {
    if (empNo && empNo !== actorEmpNo && !recipients.has(empNo)) recipients.set(empNo, url);
  };
  if (deviceRow.approver_emp_no) {
    const x = await queryOne(
      `SELECT chu_quan_emp_no, pho_quan_1_emp_no, pho_quan_2_emp_no
       FROM xuong_mnt WHERE xuong_no = @x`,
      { x: deviceRow.approver_emp_no },
    );
    if (x) {
      add(x.chu_quan_emp_no, '/');
      add(x.pho_quan_1_emp_no, '/');
      add(x.pho_quan_2_emp_no, '/');
    }
  }
  if (deviceRow.mnt_dept_no) {
    const d = await queryOne(
      'SELECT chu_quan_emp_no, van_thu_emp_no FROM dept_mnt WHERE mnt_dept_no = @d',
      { d: deviceRow.mnt_dept_no },
    );
    if (d) {
      add(d.chu_quan_emp_no, '/dept-approval');
      add(d.van_thu_emp_no, '/dept-approval');
    }
  }
  // approved / rejected: bao them nguoi da gui don (temp ?? maintainer)
  if (type === 'approved' || type === 'rejected') {
    add(deviceRow.temp_maintainer_emp_no || deviceRow.maintainer_emp_no, '/');
  }
  return recipients;
}

// Fire-and-forget: toan bo try/catch, khong bao gio throw ra ngoai
async function dispatchApprovalEvent(type, deviceRow, actorEmpNo) {
  try {
    if (!deviceRow || !DISPATCH_TITLES[type]) return;
    const recipients = await collectRecipients(deviceRow, actorEmpNo, type);
    if (recipients.size === 0) return;

    // Ten actor + ten nguoi nhan: 1 query emp_mnt
    const allEmpNos = [actorEmpNo, ...recipients.keys()].filter(Boolean);
    const { sql: nIn, params: nParams } = inClause(allEmpNos, 'n');
    const nameRows = await query(
      `SELECT emp_no, emp_name FROM emp_mnt WHERE emp_no IN (${nIn})`,
      nParams,
    );
    const nameMap = new Map(nameRows.map((r) => [r.emp_no, r.emp_name || '']));
    const equNo = deviceRow.equ_no || '';
    const equName = deviceRow.equ_name || '';
    const body = buildBody(type, nameMap.get(actorEmpNo) || '', equName, equNo);

    // Token active cua toan bo nguoi nhan (1 query IN)
    const recipientEmpNos = [...recipients.keys()];
    const { sql: tIn, params: tParams } = inClause(recipientEmpNos, 'r');
    const tokenRows = await query(
      `SELECT emp_no, fcm_token FROM emp_push_token
       WHERE is_active = 1 AND emp_no IN (${tIn})`,
      tParams,
    );
    if (tokenRows.length === 0) return; // khong ai dang ky -> khong ghi log

    const tokenToEmp = new Map(tokenRows.map((r) => [r.fcm_token, r.emp_no]));
    // Nhom theo url de data.url dung voi trang nhan cua tung nguoi
    const byUrl = new Map();
    for (const [empNo, url] of recipients) {
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(empNo);
    }
    const allResults = [];
    const deadTokens = [];
    for (const [url, empNosForUrl] of byUrl) {
      const tokens = tokenRows
        .filter((r) => empNosForUrl.includes(r.emp_no))
        .map((r) => r.fcm_token);
      if (tokens.length === 0) continue;
      const { results, deadTokens: dead } = await fcm.sendMulticast(tokens, {
        title: DISPATCH_TITLES[type],
        body,
        data: { url },
      });
      allResults.push(...results);
      deadTokens.push(...dead);
    }

    await insertLogRows(allResults.map((r) => ({
      eventType: type,
      equNo,
      actorEmpNo: actorEmpNo || null,
      recipientEmpNo: tokenToEmp.get(r.token) || '',
      status: r.ok ? 'sent' : 'failed',
      error: r.ok ? '' : (r.errorMessage || r.errorCode || 'unknown'),
    })));

    if (deadTokens.length > 0) {
      const { sql: dIn, params: dParams } = inClause(deadTokens, 'dt');
      await query(`UPDATE emp_push_token SET is_active = 0 WHERE fcm_token IN (${dIn})`, dParams);
    }
  } catch (err) {
    console.error('[push] dispatchApprovalEvent lỗi:', err.message);
  }
}

module.exports = {
  registerToken,
  unregisterToken,
  listTokens,
  toggleToken,
  listLog,
  sendTest,
  dispatchApprovalEvent,
};
