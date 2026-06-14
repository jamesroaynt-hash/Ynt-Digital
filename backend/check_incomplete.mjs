const { createDatabaseClient } = await import('./db/client.js');
const db = createDatabaseClient({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const total = await db.prepare('SELECT COUNT(*) AS cnt FROM pos_orders').get();
const noStatus = await db.prepare(`SELECT COUNT(*) AS cnt FROM pos_orders WHERE status_name IS NULL OR TRIM(status_name) = ''`).get();
const noPosId = await db.prepare(`SELECT COUNT(*) AS cnt FROM pos_orders WHERE external_id IS NULL OR TRIM(external_id) = ''`).get();
const noStatusOrId = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM pos_orders
  WHERE (status_name IS NULL OR TRIM(status_name) = '')
     OR (external_id IS NULL OR TRIM(external_id) = '')
`).get();
const notLinked = await db.prepare(`
  SELECT COUNT(*) AS cnt FROM pos_orders po
  LEFT JOIN integration_source_links isl
    ON isl.provider = 'pancake_pos' AND isl.entity_type = 'orders' AND isl.external_id = po.external_id
  WHERE isl.local_id IS NULL
`).get();

console.log(`Total pos_orders:          ${total.cnt}`);
console.log(`No status_name:            ${noStatus.cnt}`);
console.log(`No external_id (POS ID):   ${noPosId.cnt}`);
console.log(`No status OR no POS ID:    ${noStatusOrId.cnt}`);
console.log(`Not linked to dashboard:   ${notLinked.cnt}`);
console.log(`Would keep (has both):     ${total.cnt - noStatusOrId.cnt}`);
