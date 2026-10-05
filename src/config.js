require('dotenv').config();

const config = {
  port: Number(process.env.PORT || 3100),
  // 127.0.0.1: chi nginx/reverse proxy moi goi duoc — khong mo truc tiep ra internet
  host: process.env.HOST || '127.0.0.1',
  // Token phien: song sessionTtlDays ngay; dat ALLOW_HTTP=1 khi chay noi bo/dev
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 30),
  allowHttp: String(process.env.ALLOW_HTTP || 'false') === 'true',
  // Chan do PIN: sai pinMaxAttempts lan lien tiep thi khoa pinLockMinutes phut
  pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS || 5),
  pinLockMinutes: Number(process.env.PIN_LOCK_MINUTES || 15),
  db: {
    server: process.env.DB_SERVER || '127.0.0.1',
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
    options: {
      encrypt: false,
      trustServerCertificate:
        String(process.env.DB_TRUST_SERVER_CERT || 'true') === 'true',
      // useUTC mac dinh = true: driver doc/ghi Date luon theo tuong UTC, bo qua TZ process.
      // Dat false de driver theo TZ process (da ghim Asia/Hong_Kong o dong dau index.js),
      // khop voi GETDATE() (dong ho DB HK). Chinh dong nay moi la khoa chinh;
      // chi ghim process.env.TZ thi van bi useUTC=true ghi de.
      useUTC: false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 60000,
  },
  // Cot he thong _updated_at: mac dinh TAT ('') vi bang eqm_mnt tu tao trong SQL Server
  // thuong khong co cot nay (loi 'Invalid column name _updated_at'). Chi dat
  // UPDATED_AT_COL=_updated_at khi bang cua ban thuc su co cot do.
  updatedAtCol: process.env.UPDATED_AT_COL ?? '',
  registerPassword: process.env.REGISTER_PASSWORD || 'bt2607',
  // Gioi han thu mat khau dang ky (cua so truot trong bo nho)
  registerMaxAttempts: Number(process.env.REGISTER_MAX_ATTEMPTS || 10),
  registerWindowMinutes: Number(process.env.REGISTER_WINDOW_MINUTES || 15),
  faceQualityUrl: process.env.FACE_QUALITY_URL || '',
  faceCompareUrl: process.env.FACE_COMPARE_URL || '',
};

module.exports = config;
