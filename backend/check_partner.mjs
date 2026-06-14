const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Sample partner_json values that have extend_update
const rows = await db.prepare(`
  SELECT external_id, status, status_name, partner_json
  FROM pos_orders
  WHERE partner_json IS NOT NULL AND partner_json != 'null' AND partner_json != '{}'
  ORDER BY updated_at DESC
  LIMIT 20
`).all();

console.log(`Rows with partner_json: ${rows.length}`);
for (const row of rows) {
  let partner = null;
  try { partner = JSON.parse(row.partner_json); } catch {}
  if (!partner) continue;
  const updates = partner?.extend_update;
  const latestStatus = Array.isArray(updates)
    ? [...updates].reverse().find(u => u?.status)?.status
    : null;
  console.log(`[${row.status}] ${row.status_name} | partner keys: ${Object.keys(partner).join(', ')}`);
  if (latestStatus) console.log(`  latest extend_update status: "${latestStatus}"`);
  if (partner.status) console.log(`  partner.status: "${partner.status}"`);
  if (partner.status_name) console.log(`  partner.status_name: "${partner.status_name}"`);
}

// Count how many have partner status that differs from POS status
const withPartner = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM pos_orders
  WHERE partner_json IS NOT NULL AND partner_json NOT IN ('null','{}','')
`).get();
console.log(`\nTotal pos_orders with partner data: ${withPartner.cnt}`);
