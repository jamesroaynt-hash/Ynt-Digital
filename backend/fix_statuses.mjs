const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Fix wait_print (code 12) → Waiting for pickup
const wfp = await db.prepare(`
  UPDATE orders SET status = 'Waiting for pickup', updated_at = datetime('now')
  WHERE id IN (
    SELECT CAST(isl.local_id AS INTEGER)
    FROM integration_source_links isl
    INNER JOIN pos_orders po ON po.external_id = isl.external_id
    WHERE isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
      AND isl.local_table = 'orders'
      AND po.status = 12
  )
  AND status != 'Waiting for pickup'
`).run();
process.stderr.write(`wait_print fixed: ${wfp.changes || 0}\n`);

// Fix pending (code 9) → Waiting for pickup
const pending = await db.prepare(`
  UPDATE orders SET status = 'Waiting for pickup', updated_at = datetime('now')
  WHERE id IN (
    SELECT CAST(isl.local_id AS INTEGER)
    FROM integration_source_links isl
    INNER JOIN pos_orders po ON po.external_id = isl.external_id
    WHERE isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
      AND isl.local_table = 'orders'
      AND po.status = 9
  )
  AND status != 'Waiting for pickup'
`).run();
process.stderr.write(`pending fixed: ${pending.changes || 0}\n`);

// Fix new (code 0) that got mapped to Confirmed → New
const newOrders = await db.prepare(`
  UPDATE orders SET status = 'New', updated_at = datetime('now')
  WHERE id IN (
    SELECT CAST(isl.local_id AS INTEGER)
    FROM integration_source_links isl
    INNER JOIN pos_orders po ON po.external_id = isl.external_id
    WHERE isl.provider = 'pancake_pos' AND isl.entity_type = 'orders'
      AND isl.local_table = 'orders'
      AND po.status = 0
  )
  AND status = 'Confirmed'
`).run();
process.stderr.write(`new orders fixed: ${newOrders.changes || 0}\n`);

process.stderr.write('Done.\n');
