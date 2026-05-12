const { PostgresClient } = require('../db/client');
const posSync = require('../services/pancakePosSync');

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres.qlsalnuqwuxyaipvtqdz:YntDashboard2026StrongPass@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
const db = new PostgresClient(DB_URL);

async function run() {
  console.log('[syncNow] Starting POS sync...');
  try {
    const result = await posSync.collectPosData(db, {
      api_key: '06e1c905e3b042fea32ee911d2c7d872',
      shop_id: '100956439',
      resources: ['orders'],
      page_size: 30,
      max_pages: 15,
    });
    console.log('[syncNow] Orders fetched:', result.resources?.orders?.count ?? 0);
    if (result.failed_resources?.length) console.log('[syncNow] Failures:', result.failed_resources);
  } catch (err) {
    console.error('[syncNow] Sync error:', err.message);
  }

  const posCount = await db.prepare('SELECT COUNT(*) as cnt FROM pos_orders').get();
  const ordersCount = await db.prepare('SELECT COUNT(*) as cnt FROM orders').get();
  console.log('[syncNow] pos_orders total:', posCount.cnt);
  console.log('[syncNow] dashboard orders total:', ordersCount.cnt);
  await db.close();
}

run().catch(e => { console.error(e.message); process.exit(1); });
