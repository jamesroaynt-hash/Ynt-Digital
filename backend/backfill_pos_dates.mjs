/**
 * Backfills inserted_at_remote and updated_at_remote in pos_orders
 * by re-reading the values stored in raw_payload, then corrects the linked
 * dashboard orders.order_date to the Manila (UTC+8) calendar date so the
 * Today/date filters match — POS timestamps are UTC and a plain slice rolled
 * PH early-morning orders back a day.
 * Safe to re-run — only updates rows that actually change.
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

function normalizePosTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isNaN(num) && num > 1_000_000_000) {
    const ms = num > 9_999_999_999 ? num : num * 1000;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
  return String(value).trim() || null;
}

// Resolve a POS timestamp (ISO string, "YYYY-MM-DD HH:MM:SS" UTC, or Unix s/ms)
// to an epoch in ms. Bare UTC "YYYY-MM-DD HH:MM:SS" has no zone marker, so force
// UTC — otherwise this would parse as the runner's local time and be wrong.
function parseInstantMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isNaN(num) && num > 1_000_000_000) {
    return num > 9_999_999_999 ? num : num * 1000;
  }
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = `${s.replace(' ', 'T')}Z`;
  }
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function toManilaDate(value) {
  const ms = parseInstantMs(value);
  if (ms === null) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ms);
}

const db = createDatabaseClient({ filename: path.join(__dirname, 'db', 'ynt.db') });

const rows = await db.prepare('SELECT id, external_id, inserted_at_remote, updated_at_remote, raw_payload FROM pos_orders').all();
console.log(`Processing ${rows.length} orders...`);

let updated = 0;
let skipped = 0;

for (const row of rows) {
  let payload = null;
  try {
    payload = row.raw_payload ? JSON.parse(row.raw_payload) : null;
  } catch {
    skipped++;
    continue;
  }
  if (!payload) { skipped++; continue; }

  const newInserted = normalizePosTimestamp(payload.inserted_at);
  const newUpdated  = normalizePosTimestamp(payload.updated_at);

  if (!newInserted && !newUpdated) { skipped++; continue; }

  const setInserted = newInserted || row.inserted_at_remote;
  const setUpdated  = newUpdated  || row.updated_at_remote;

  if (setInserted === row.inserted_at_remote && setUpdated === row.updated_at_remote) {
    skipped++;
    continue;
  }

  await db.prepare(
    'UPDATE pos_orders SET inserted_at_remote = ?, updated_at_remote = ? WHERE id = ?'
  ).run(setInserted, setUpdated, row.id);
  updated++;
}

console.log(`pos_orders timestamps — updated: ${updated}, skipped: ${skipped}`);

// Correct linked dashboard orders.order_date to the Manila calendar date.
const linked = await db.prepare(`
  SELECT o.id AS order_id, o.order_date AS current_date_,
         COALESCE(po.inserted_at_remote, po.updated_at_remote) AS ts, po.raw_payload AS raw
  FROM integration_source_links isl
  INNER JOIN pos_orders po ON po.external_id = isl.external_id
  INNER JOIN orders o ON o.id = CAST(isl.local_id AS INTEGER)
  WHERE isl.provider = 'pancake_pos' AND isl.entity_type = 'orders' AND isl.local_table = 'orders'
`).all();
console.log(`Checking order_date for ${linked.length} linked dashboard orders...`);

let dateUpdated = 0;
let dateSkipped = 0;
for (const row of linked) {
  let ts = row.ts;
  if (!ts && row.raw) {
    try { ts = JSON.parse(row.raw)?.inserted_at || JSON.parse(row.raw)?.created_at; } catch { /* ignore */ }
  }
  const manila = toManilaDate(ts);
  if (!manila || manila === row.current_date_) { dateSkipped++; continue; }
  await db.prepare("UPDATE orders SET order_date = ?, updated_at = datetime('now') WHERE id = ?")
    .run(manila, row.order_id);
  dateUpdated++;
}

await db.close?.();
console.log(`orders.order_date — updated: ${dateUpdated}, skipped: ${dateSkipped}`);
console.log('Done.');
