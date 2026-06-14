const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

console.log('\n=== 1. POS STATUS_NAME VALUES vs DASHBOARD STATUS ===');
const posStatuses = await db.prepare(`
  SELECT po.status, po.status_name, o.status AS dashboard_status, COUNT(*) AS cnt
  FROM pos_orders po
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.external_id = po.external_id
  INNER JOIN orders o ON o.id = CAST(isl.local_id AS INTEGER)
  GROUP BY po.status, po.status_name, o.status
  ORDER BY cnt DESC
  LIMIT 30
`).all();
for (const r of posStatuses) {
  console.log(`  POS[${r.status}] "${r.status_name}" → Dashboard "${r.dashboard_status}" (${r.cnt})`);
}

console.log('\n=== 2. UNLINKED POS ORDERS (not on dashboard) by status ===');
const unlinked = await db.prepare(`
  SELECT po.status, po.status_name, COUNT(*) AS cnt
  FROM pos_orders po
  LEFT JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.external_id = po.external_id
  WHERE isl.local_id IS NULL
  GROUP BY po.status, po.status_name
  ORDER BY cnt DESC
  LIMIT 20
`).all();
for (const r of unlinked) {
  console.log(`  POS[${r.status}] "${r.status_name}" — NOT on dashboard (${r.cnt})`);
}

console.log('\n=== 3. TODAY\'S POS ORDERS (by API date) ===');
const today = new Date().toISOString().slice(0, 10);
const todayPos = await db.prepare(`
  SELECT po.external_id, po.customer_name, po.status_name, po.shop_id,
         po.inserted_at_remote, po.updated_at_remote,
         isl.local_id AS dash_id, o.status AS dash_status, o.order_date
  FROM pos_orders po
  LEFT JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.external_id = po.external_id
  LEFT JOIN orders o ON o.id = CAST(isl.local_id AS INTEGER)
  WHERE po.inserted_at_remote::text LIKE '${today}%'
     OR po.updated_at_remote::text LIKE '${today}%'
  ORDER BY po.updated_at_remote DESC
  LIMIT 20
`).all();
console.log(`  Today's POS orders (inserted or updated): ${todayPos.length}`);
for (const r of todayPos) {
  console.log(`  [${r.external_id?.slice(0,12)}] ${r.customer_name} | POS: ${r.status_name} | Dash: ${r.dash_status || 'NOT LINKED'} | inserted=${r.inserted_at_remote?.slice(0,10)} updated=${r.updated_at_remote?.slice(0,10)}`);
}

console.log('\n=== 4. SOURCE_SHEET vs SHOP/PAGE (page alignment) ===');
const sources = await db.prepare(`
  SELECT o.source_sheet, po.shop_id, po.page_id, COUNT(*) AS cnt
  FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
  INNER JOIN pos_orders po ON po.external_id = isl.external_id
  GROUP BY o.source_sheet, po.shop_id, po.page_id
  ORDER BY cnt DESC
  LIMIT 20
`).all();
for (const r of sources) {
  console.log(`  source_sheet="${r.source_sheet}" | shop=${r.shop_id} | page_id=${r.page_id} (${r.cnt} orders)`);
}

console.log('\n=== 5. ORDERS WITH MISMATCHED STATUS (POS updated but dashboard not) ===');
const mismatched = await db.prepare(`
  SELECT po.status_name AS pos_status, o.status AS dash_status, COUNT(*) AS cnt
  FROM pos_orders po
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.external_id = po.external_id
  INNER JOIN orders o ON o.id = CAST(isl.local_id AS INTEGER)
  WHERE po.updated_at_remote > o.updated_at
  GROUP BY po.status_name, o.status
  ORDER BY cnt DESC
  LIMIT 20
`).all();
console.log(`  Orders where POS updated_at > dashboard updated_at:`);
for (const r of mismatched) {
  console.log(`  POS "${r.pos_status}" vs Dash "${r.dash_status}" (${r.cnt})`);
}
