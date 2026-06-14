// One-off: permanently delete all rows from the google_orders (Sheet Records)
// table. The dashboards now source from pos_orders, so this clears the retired
// Google Sheets data. Run from the backend/ folder:
//   node clear_google_orders.js
// Requires DATABASE_URL in backend/.env (Supabase/Railway Postgres).
const fs = require('fs');
const { Pool } = require('pg');

const env = fs.readFileSync('.env', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT COUNT(*)::int AS count FROM google_orders');
    await client.query('TRUNCATE TABLE google_orders RESTART IDENTITY');
    const after = await client.query('SELECT COUNT(*)::int AS count FROM google_orders');
    await client.query('COMMIT');
    console.log(JSON.stringify({
      table: 'google_orders',
      before: before.rows[0]?.count || 0,
      deleted: before.rows[0]?.count || 0,
      after: after.rows[0]?.count || 0,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
