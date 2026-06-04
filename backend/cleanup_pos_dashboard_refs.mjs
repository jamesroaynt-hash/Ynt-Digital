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

function datePart(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'db/ynt.db');
const db = createDatabaseClient({ filename: dbPath });
const shopId = process.argv[2] || null;
const mergeConflicts = process.argv.includes('--merge-conflicts');

try {
  const rows = await db.prepare(`
    SELECT o.id, o.order_ref, po.external_id, po.inserted_at_remote
    FROM orders o
    INNER JOIN integration_source_links isl
      ON isl.provider = 'pancake_pos'
     AND isl.entity_type = 'orders'
     AND isl.local_table = 'orders'
     AND isl.local_id = CAST(o.id AS TEXT)
    INNER JOIN pos_orders po ON po.external_id = isl.external_id
    WHERE o.order_ref = 'POS-' || po.external_id
      ${shopId ? 'AND po.shop_id = ?' : ''}
  `).all(...(shopId ? [shopId] : []));

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const conflict = await db.prepare(
      'SELECT id, order_ref, customer, status, source_sheet, order_date FROM orders WHERE order_ref = ? AND id != ? LIMIT 1'
    ).get(row.external_id, row.id);
    if (conflict) {
      if (mergeConflicts) {
        await db.prepare(`
          UPDATE integration_source_links
          SET local_id = ?, last_synced_at = datetime('now')
          WHERE provider = 'pancake_pos'
            AND entity_type = 'orders'
            AND local_table = 'orders'
            AND external_id = ?
        `).run(String(conflict.id), row.external_id);
        await db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
        updated += 1;
      } else {
        if (skipped < 10) {
          console.log(JSON.stringify({ skipped: row, conflict }));
        }
        skipped += 1;
      }
      continue;
    }
    await db.prepare(`
      UPDATE orders
      SET order_ref = ?, order_date = COALESCE(?, order_date), updated_at = datetime('now')
      WHERE id = ?
    `).run(row.external_id, datePart(row.inserted_at_remote), row.id);
    updated += 1;
  }

  console.log(JSON.stringify({ shop_id: shopId, merge_conflicts: mergeConflicts, candidates: rows.length, updated, skipped }, null, 2));
} finally {
  await db.close();
}
