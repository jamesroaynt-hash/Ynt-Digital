import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from './db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const ids = process.argv.slice(2);
if (!ids.length) {
  ids.push('65468', '65471', '65469', '65470', '65466', '65467');
}

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'db/ynt.db');
const db = createDatabaseClient({ filename: dbPath });

try {
  console.log(`Checking POS IDs: ${ids.join(', ')}`);
  for (const id of ids) {
    const row = await db.prepare(`
      SELECT external_id, shop_id, page_name, customer_name, status_name,
             inserted_at_remote, updated_at_remote, created_at, updated_at
      FROM pos_orders
      WHERE external_id = ?
      LIMIT 1
    `).get(String(id));
    if (!row) {
      console.log(`${id}: NOT FOUND`);
    } else {
      console.log(`${id}: ${JSON.stringify(row)}`);
      const link = await db.prepare(`
        SELECT local_table, local_id, last_synced_at
        FROM integration_source_links
        WHERE provider = 'pancake_pos' AND entity_type = 'orders' AND external_id = ?
        LIMIT 1
      `).get(String(id));
      if (!link) {
        console.log(`${id}: no dashboard order link`);
      } else {
        const order = await db.prepare(`
          SELECT id, order_ref, customer, status, source_sheet, order_date, updated_at
          FROM orders
          WHERE id = ?
          LIMIT 1
        `).get(link.local_id);
        console.log(`${id}: link=${JSON.stringify(link)} dashboard=${JSON.stringify(order || null)}`);
      }
    }
  }

  const latest = await db.prepare(`
    SELECT external_id, shop_id, page_name, customer_name, status_name,
           inserted_at_remote, updated_at_remote
    FROM pos_orders
    ORDER BY inserted_at_remote DESC NULLS LAST, updated_at_remote DESC NULLS LAST
    LIMIT 10
  `).all();
  console.log('\nLatest stored POS rows:');
  for (const row of latest) console.log(JSON.stringify(row));
} finally {
  await db.close();
}
