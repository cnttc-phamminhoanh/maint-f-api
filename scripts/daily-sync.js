// Job lich su tre han chay 1 lan/ngay qua cron Linux (nguon ghi duy nhat):
//   5 0 * * * cd <duong-dan>/local-api && node scripts/daily-sync.js >> /var/log/mnt-delay-sync.log 2>&1
const { connectDb, getPool } = require('../src/db');
const { runSync } = require('../src/services/delayed.service');

async function main() {
  await connectDb();
  const result = await runSync();
  console.log('[daily-sync] ok', JSON.stringify(result));
  await getPool().close();
}

main().catch((err) => {
  console.error('[daily-sync] fail', err);
  process.exitCode = 1;
});
