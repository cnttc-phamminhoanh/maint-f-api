const config = require('../config');

// Chi chap nhan HTTPS khi chay public. Dat ALLOW_HTTP=1 khi chay local. Dung sau nginx/reverse proxy: app.set('trust proxy', true) de doc X-Forwarded-Proto.
function requireHttps(req, res, next) {
  if (config.allowHttp) return next();
  const proto = req.get('x-forwarded-proto') || req.protocol;
  if (proto === 'https') return next();
  res.status(426).json({
    statusCode: 426,
    message: 'HTTPS_REQUIRED: API chỉ nhận kết nối HTTPS khi công khai (đặt ALLOW_HTTP=1 nếu chạy local)',
  });
}

module.exports = { requireHttps };
