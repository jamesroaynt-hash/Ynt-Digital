/**
 * Diagnoses why a POS order's dashboard status is stale.
 * Usage: node check_order_status.mjs [external_id]   (default 65472)
 * Run it where the LIVE db lives (Railway), not a stale local copy.
 */
import { createDatabaseClient } from './db/client.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    const val = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

const target = String(process.argv[2] || '65472');
const db = createDatabaseClient({ filename: path.join(__dirname, 'db', 'ynt.db') });

// pos_orders may key on external_id (UUID) or the human order code is in raw_payload.
const po = await db.prepare(`
  SELECT external_id, status, status_name, updated_at_remote, updated_at, raw_payload
  FROM pos_orders
  WHERE external_id = ? OR raw_payload LIKE ?
  LIMIT 1
`).get(target, `%"id":${target}%`);

if (!po) {
  console.log(`No pos_orders row found for "${target}".`);
} else {
  let rawStatus = null; let rawStatusName = null;
  try {
    const raw = JSON.parse(po.raw_payload || '{}');
    rawStatus = raw.status; rawStatusName = raw.status_name;
  } catch { /* ignore */ }

  console.log('--- pos_orders ---');
  console.log({
    external_id: po.external_id,
    status_numeric: po.status,
    status_name: po.status_name,
    raw_payload_status: rawStatus,
    raw_payload_status_name: rawStatusName,
    updated_at_remote: po.updated_at_remote,
    row_updated_at: po.updated_at,
  });

  const link = await db.prepare(`
    SELECT local_id FROM integration_source_links
    WHERE provider = 'pancake_pos' AND entity_type = 'orders' AND local_table = 'orders' AND external_id = ?
    LIMIT 1
  `).get(po.external_id);

  if (!link) {
    console.log('--- dashboard order: NOT LINKED ---');
  } else {
    const o = await db.prepare('SELECT id, order_ref, customer, status, order_date, updated_at FROM orders WHERE id = ?')
      .get(Number(link.local_id));
    console.log('--- dashboard orders row ---');
    console.log(o || `(link points to missing order id ${link.local_id})`);
  }
}

await db.close?.();
