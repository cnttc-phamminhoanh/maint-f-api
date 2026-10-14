// Firebase Cloud Messaging — khoi tao luoi (lazy) tu bien moi truong.
// FIREBASE_SERVICE_ACCOUNT: duong dan file JSON service account
// FIREBASE_SERVICE_ACCOUNT_JSON: noi dung JSON service account (uu tien neu co ca hai)
// PUSH_ENABLED=false: tat hoan toan, moi ham send tra mang rong.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

let messaging = null;
let warnedNoCredential = false;

function hasCredential() {
  return !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT);
}

function isPushEnabled() {
  return process.env.PUSH_ENABLED !== 'false' && hasCredential();
}

// Chi goi admin.initializeApp lan dau; tra ve null neu khong co credential hop le
function getMessaging() {
  if (messaging) return messaging;
  let credential = null;
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (jsonRaw) {
    try {
      credential = admin.credential.cert(JSON.parse(jsonRaw));
    } catch (err) {
      console.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON không hợp lệ:', err.message);
    }
  } else if (filePath) {
    try {
      const raw = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8');
      credential = admin.credential.cert(JSON.parse(raw));
    } catch (err) {
      console.error('[push] Không đọc được FIREBASE_SERVICE_ACCOUNT:', err.message);
    }
  }
  if (!credential) {
    if (!warnedNoCredential) {
      warnedNoCredential = true;
      console.warn('[push] Chưa cấu hình credential Firebase (FIREBASE_SERVICE_ACCOUNT hoặc FIREBASE_SERVICE_ACCOUNT_JSON) — push đang tắt');
    }
    return null;
  }
  if (admin.apps.length === 0) admin.initializeApp({ credential });
  messaging = admin.messaging();
  return messaging;
}

// Gui 1 payload toi nhieu token. KHONG bao gio throw:
// moi loi deu tra ve ket qua failed de caller ghi push_log.
async function sendMulticast(tokens, { title, body, data }) {
  const safeTokens = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
  if (!isPushEnabled() || safeTokens.length === 0) return { results: [], deadTokens: [] };
  try {
    const msg = getMessaging();
    if (!msg) return { results: [], deadTokens: [] };
    // FCM data chi nhan gia tri chuoi
    const safeData = {};
    for (const [k, v] of Object.entries(data || {})) safeData[k] = String(v);
    // 2026-10-14 ROOT CAUSE thông báo TRÙNG：payload có trường `notification`
    // thì FCM Web SDK TỰ hiện 1 thông báo（bấm vào mở gốc domain → nhảy
    // accounts.feishu.cn vì app chạy trong container Feishu chưa đăng nhập），
    // đồng thời onBackgroundMessage trong firebase-messaging-sw.js lại
    // showNotification thêm 1 cái = 2 thông báo từ 1 token 1 lần gửi。
    // Sửa：gửi DATA-ONLY（không trường notification），title/body vào data，
    // SW hiện đúng 1 cái kèm data.url。SW đọc notification.title || data.title
    // nên không cần đổi firebase-messaging-sw.js
    safeData.title = String(title);
    safeData.body = String(body);
    const response = await msg.sendEachForMulticast({
      tokens: safeTokens,
      data: safeData,
    });
    const results = [];
    const deadTokens = [];
    response.responses.forEach((r, i) => {
      const token = safeTokens[i];
      if (r.success) {
        results.push({ token, ok: true });
        return;
      }
      const errorCode = r.error && r.error.code ? r.error.code : 'unknown';
      const errorMessage = r.error && r.error.message ? r.error.message : 'unknown error';
      results.push({ token, ok: false, errorCode, errorMessage });
      if (
        errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-argument'
      ) {
        deadTokens.push(token);
      }
    });
    return { results, deadTokens };
  } catch (err) {
    console.error('[push] sendMulticast lỗi:', err.message);
    return {
      results: safeTokens.map((token) => ({
        token,
        ok: false,
        errorCode: 'unknown',
        errorMessage: err.message,
      })),
      deadTokens: [],
    };
  }
}

module.exports = { isPushEnabled, sendMulticast };
