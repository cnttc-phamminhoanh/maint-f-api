const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const { connectDb } = require('./db');
const { notFoundHandler, errorHandler } = require('./errors');
const swaggerSpec = require('./swagger');
const { requireHttps } = require('./middleware/require-https');
const { requireAuth, assertSameUser } = require('./middleware/require-auth');

const authRoutes = require('./routes/auth.routes');
const devicesRoutes = require('./routes/devices.routes');
const ordersRoutes = require('./routes/maintenance-orders.routes');
const delayedRoutes = require('./routes/delayed.routes');
const statisticsRoutes = require('./routes/statistics.routes');

const app = express();

// Doc X-Forwarded-Proto/IP chinh xac khi chay sau nginx/reverse proxy
app.set('trust proxy', true);
app.use(requireHttps);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'API Bảo dưỡng thiết bị' }));
app.get('/docs.json', (req, res) => res.json(swaggerSpec));

app.use('/api/auth', authRoutes);

// Trang BI la cong khai (giong cloud: statistics controller khong can login)
app.use('/api/statistics', statisticsRoutes);

// Authorization: Bearer <token> va userId trong body/query phai trung voi chu phien
app.use(requireAuth);
app.use(assertSameUser);

app.use('/api/devices', devicesRoutes);
app.use('/api/maintenance-orders', ordersRoutes);
app.use('/api/delayed-devices', delayedRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  try {
    await connectDb();
  } catch (err) {
    console.error('[FATAL] Không kết nối được SQL Server:', err.message);
    process.exit(1);
  }
  app.listen(config.port, config.host, () => {
    console.log(`API đang chạy tại http://${config.host}:${config.port}`);
    console.log(`Swagger UI: http://${config.host}:${config.port}/docs`);
    if (!config.allowHttp) {
      console.log('[SECURITY] Chế độ công khai: chỉ nhận HTTPS (đặt sau reverse proxy TLS). Đặt ALLOW_HTTP=1 khi chạy nội bộ/dev.');
    }
  });
}

start();

module.exports = app;
