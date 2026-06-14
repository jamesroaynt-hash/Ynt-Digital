import { createDatabaseClient } from './db/client.js';

const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Get a few pos_orders rows to inspect their structure
const rows = await db.prepare(`
  SELECT external_id, shop_id, items_json, tags_json, partner_json, raw_payload
  FROM pos_orders
  ORDER BY id DESC
  LIMIT 10
`).all();

console.log(`Total rows sampled: ${rows.length}`);
for (const row of rows) {
  const raw = row.raw_payload && row.raw_payload !== '{}' ? JSON.parse(row.raw_payload) : null;
  const items = JSON.parse(row.items_json || '[]');
  const partner = JSON.parse(row.partner_json || 'null');

  console.log(`\n--- Order ${row.external_id} (shop ${row.shop_id}) ---`);
  console.log(`  items_json count: ${items.length}`);
  console.log(`  raw_payload keys: ${raw ? Object.keys(raw).slice(0, 30).join(', ') : '(empty)'}`);
  if (raw) {
    // Look for confirmer-like keys in raw payload top level
    const confirmerKeys = Object.keys(raw).filter(k =>
      k.toLowerCase().includes('confirm') ||
      k.toLowerCase().includes('seller') ||
      k.toLowerCase().includes('employee') ||
      k.toLowerCase().includes('staff') ||
      k.toLowerCase().includes('assign') ||
      k.toLowerCase().includes('creator') ||
      k.toLowerCase().includes('marketer') ||
      k.toLowerCase().includes('created_by')
    );
    if (confirmerKeys.length) console.log(`  Confirmer keys: ${confirmerKeys.map(k => `${k}=${JSON.stringify(raw[k])}`).join(', ')}`);
    else console.log(`  No confirmer keys at top level`);

    // Check partner object
    if (raw.partner && typeof raw.partner === 'object') {
      const pkeys = Object.keys(raw.partner).filter(k =>
        k.toLowerCase().includes('confirm') || k.toLowerCase().includes('seller') ||
        k.toLowerCase().includes('employee') || k.toLowerCase().includes('staff') ||
        k.toLowerCase().includes('assign') || k.toLowerCase().includes('creator')
      );
      if (pkeys.length) console.log(`  Partner confirmer keys: ${pkeys.map(k => `${k}=${JSON.stringify(raw.partner[k])}`).join(', ')}`);
    }
  }

  // Check if items have product names
  if (items.length > 0) {
    const names = items.map(i => i?.variation_name || i?.product_name || i?.name || '?').join(', ');
    console.log(`  Item names: ${names.substring(0, 100)}`);
  }
}

// Check total pos_orders count
const total = await db.prepare('SELECT COUNT(*) AS cnt FROM pos_orders').get();
console.log(`\nTotal pos_orders: ${total?.cnt}`);

// Check how many have non-empty items_json
const withItems = await db.prepare(`SELECT COUNT(*) AS cnt FROM pos_orders WHERE items_json != '[]' AND items_json IS NOT NULL`).get();
console.log(`pos_orders with items: ${withItems?.cnt}`);
