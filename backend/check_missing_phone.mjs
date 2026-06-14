const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const total = await db.prepare('SELECT COUNT(*) AS cnt FROM pos_orders').get();
const withPhone = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM pos_orders
  WHERE customer_phone IS NOT NULL AND customer_phone <> ''
`).get();

console.log(`Total pos_orders:         ${total.cnt}`);
console.log(`With customer_phone:      ${withPhone.cnt}`);
console.log(`Missing customer_phone:   ${total.cnt - withPhone.cnt}\n`);

const rows = await db.prepare(`
  SELECT external_id, customer_name, customer_phone, status_name,
         page_name, shop_id, inserted_at_remote
  FROM pos_orders
  WHERE customer_phone IS NULL OR customer_phone = ''
  ORDER BY inserted_at_remote DESC
`).all();

if (!rows.length) {
  console.log('No rows missing customer_phone.');
} else {
  console.log(`Rows missing customer_phone (${rows.length}):`);
  for (const row of rows) {
    console.log(
      `  ${row.inserted_at_remote || '?'.padEnd(20)} | ` +
      `id=${row.external_id} | ` +
      `name=${row.customer_name || '(none)'} | ` +
      `status=${row.status_name || '(none)'} | ` +
      `page=${row.page_name || '(none)'} | ` +
      `shop=${row.shop_id || '(none)'}`
    );
  }
}

if (db.close) await db.close();
