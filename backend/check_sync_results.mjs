import { createDatabaseClient } from './db/client.js';

const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Total POS-linked orders
const total = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
`).get();

// Orders with confirmed_by populated
const withConfirmedBy = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
  WHERE o.confirmed_by IS NOT NULL AND TRIM(o.confirmed_by) != ''
`).get();

// Orders missing customer or product (should be 0 if cleanup worked)
const malformed = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
  WHERE o.customer IS NULL OR TRIM(o.customer) = ''
    OR o.product IS NULL OR TRIM(o.product) = ''
`).get();

// Sample of confirmed_by values
const samples = await db.prepare(`
  SELECT o.confirmed_by, COUNT(*) AS cnt FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
  WHERE o.confirmed_by IS NOT NULL AND TRIM(o.confirmed_by) != ''
  GROUP BY o.confirmed_by
  ORDER BY cnt DESC
  LIMIT 15
`).all();

// Recent orders
const recent = await db.prepare(`
  SELECT o.id, o.customer, o.product, o.confirmed_by, o.status, o.order_date
  FROM orders o
  INNER JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
    AND isl.local_table = 'orders' AND CAST(isl.local_id AS INTEGER) = o.id
  ORDER BY o.id DESC
  LIMIT 10
`).all();

console.log('=== POS Sync Results ===');
console.log(`Total POS-linked orders: ${total?.cnt ?? total?.count}`);
console.log(`With confirmed_by: ${withConfirmedBy?.cnt ?? withConfirmedBy?.count}`);
console.log(`Malformed (no customer/product): ${malformed?.cnt ?? malformed?.count}`);
console.log('\nTop confirmed_by values:');
for (const s of (samples || [])) {
  console.log(`  ${s.confirmed_by}: ${s.cnt ?? s.count}`);
}
console.log('\nRecent 10 POS orders:');
for (const r of (recent || [])) {
  console.log(`  [${r.id}] ${r.customer} | ${r.product?.substring(0,30)} | confirmed_by=${r.confirmed_by} | status=${r.status} | date=${r.order_date}`);
}
