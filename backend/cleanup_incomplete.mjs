const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

process.stderr.write('Deleting pos_orders with no status_name...\n');
const del = await db.prepare(`
  DELETE FROM pos_orders
  WHERE status_name IS NULL OR TRIM(status_name) = ''
`).run();
process.stderr.write(`Deleted: ${del.changes || del.rowCount || 0} pos_orders\n`);

process.stderr.write('Cleaning up orphaned integration_source_links...\n');
const linkDel = await db.prepare(`
  DELETE FROM integration_source_links
  WHERE provider = 'pancake_pos'
    AND entity_type = 'orders'
    AND local_table = 'orders'
    AND CAST(local_id AS INTEGER) NOT IN (SELECT id FROM orders)
`).run();
process.stderr.write(`Deleted: ${linkDel.changes || linkDel.rowCount || 0} orphaned source links\n`);

const remaining = await db.prepare('SELECT COUNT(*) AS cnt FROM pos_orders').get();
process.stderr.write(`Remaining pos_orders: ${remaining.cnt}\n`);
