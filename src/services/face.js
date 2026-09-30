const config = require('../config');

// Goi dich vu AI ben ngoai (neu da cau hinh URL trong .env).
// Kich hoat cac file nay trong he thong cu dung plugin AI cua platform;
// API doc lap nay can ban tich hop dich vu AI cua rieng ban.

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Face service responded ${res.status}`);
  return res.json();
}

// Tra ve mang van de (['has_face', ...]); rong = dat yeu cau
async function faceQualityCheck(imageUrl) {
  if (!config.faceQualityUrl) return []; // khong cau hinh -> bo qua
  const data = await postJson(config.faceQualityUrl, { imageUrl });
  return Array.isArray(data.issues) ? data.issues : [];
}

// Tra ve boolean: khuon mat trong anh co khop voi anh da dang ky khong
async function faceCompare(imageUrl, registeredUrl) {
  if (!config.faceCompareUrl) {
    const err = new Error('FACE_COMPARE_NOT_CONFIGURED');
    err.code = 'FACE_COMPARE_NOT_CONFIGURED';
    throw err;
  }
  const data = await postJson(config.faceCompareUrl, { imageUrl, registeredUrl });
  return Boolean(data.matched);
}

module.exports = { faceQualityCheck, faceCompare };
