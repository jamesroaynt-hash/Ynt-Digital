// Recompute partner_reason and undeliverable_since from the partner_json we
// already store — no Pancake calls needed.
//
// The reason extractor only ever matched `reason [<text>]` embedded in a status
// string. J&T sends a plain `note` on the failure entry instead, so every
// undeliverable order we hold had a NULL reason while carrying one in its
// payload. This walks the stored payloads and fills both columns in.
//
// Usage: node backend/scripts/backfill_undeliverable.js [--dry]
const fs = require('fs');
const path = require('path');
const { PostgresClient } = require('../db/client');

const DRY = process.argv.includes('--dry');
const COURIER_REASON_RE = /reason\s*[[【]\s*([^\]】]+?)\s*[\]】]/gi;
const FAILURE_STATES = new Set(['undeliverable', 'returning', 'returned']);

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL not found in environment or backend/.env');
}

function normalize(ts) {
  const text = String(ts || '').trim();
  if (!text) return null;
  return text.replace('T', ' ').slice(0, 19) || null;
}

// Same rule as getPosUndeliverableReason in the sync: newest note wins, the
// embedded `reason [..]` form is the fallback.
function unwrap(text) {
  const found = [...String(text).matchAll(COURIER_REASON_RE)];
  return found.length ? found[found.length - 1][1].trim() : null;
}

function reasonOf(partner) {
  const updates = Array.isArray(partner.extend_update) ? partner.extend_update : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const note = String(updates[i]?.note || '').trim();
    if (note) return unwrap(note) || note;
  }
  return unwrap(JSON.stringify(partner));
}

function sinceOf(partner) {
  if (partner.first_undeliverable_at) return normalize(partner.first_undeliverable_at);
  const updates = Array.isArray(partner.extend_update) ? partner.extend_update : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    if (String(updates[i]?.note || '').trim() && updates[i]?.update_at) {
      return normalize(updates[i].update_at);
    }
  }
  return normalize(partner.updated_at);
}

async function run() {
  const db = new PostgresClient(loadDatabaseUrl());
  const rows = await db.prepare(
    `SELECT shop_id, external_id, partner_status, partner_reason, undeliverable_since, partner_json
     FROM pos_orders
     WHERE partner_json IS NOT NULL AND TRIM(partner_json) NOT IN ('', '{}', 'null')`
  ).all();
  console.log(`[undeliverable] ${rows.length} orders carry a partner payload`);

  const writes = [];
  let reasons = 0;
  for (const row of rows) {
    let partner = {};
    try { partner = JSON.parse(row.partner_json) || {}; } catch { continue; }
    if (!partner || typeof partner !== 'object') continue;

    // Only while the courier is still reporting failure — see
    // COURIER_FAILURE_STATES in the sync for why a delivered order must not
    // keep the note from the attempt that failed before it arrived.
    const state = String(row.partner_status || '').toLowerCase();
    const reason = FAILURE_STATES.has(state) ? reasonOf(partner) : null;
    const since = state === 'undeliverable' ? sinceOf(partner) : null;

    if ((reason || null) === (row.partner_reason || null)
      && (since || null) === (row.undeliverable_since || null)) continue;
    if (reason && !row.partner_reason) reasons++;
    writes.push({ shop_id: row.shop_id, external_id: row.external_id, reason, since });
  }

  console.log(`[undeliverable] ${writes.length} rows to update (${reasons} gaining a reason they never had)`);
  if (DRY) { await db.close(); return; }

  for (let i = 0; i < writes.length; i += 200) {
    const chunk = writes.slice(i, i + 200);
    const values = chunk.map(() => '(?::text, ?::text, ?::text, ?::text)').join(', ');
    const params = chunk.flatMap((w) => [w.shop_id, w.external_id, w.reason, w.since]);
    await db.prepare(
      `UPDATE pos_orders SET partner_reason = v.reason, undeliverable_since = v.since
       FROM (VALUES ${values}) AS v(shop_id, external_id, reason, since)
       WHERE pos_orders.shop_id = v.shop_id AND pos_orders.external_id = v.external_id`
    ).run(...params);
    console.log(`[undeliverable] updated ${Math.min(i + 200, writes.length)}/${writes.length}`);
  }

  const after = await db.prepare(
    `SELECT COUNT(*) AS undeliverable,
            COUNT(partner_reason) AS with_reason,
            COUNT(undeliverable_since) AS with_since
     FROM pos_orders WHERE LOWER(COALESCE(partner_status,'')) = 'undeliverable'`
  ).get();
  console.log(`[undeliverable] AFTER: ${after.with_reason}/${after.undeliverable} undeliverable orders have a reason, ${after.with_since} have a failed-at date`);
  await db.close();
}

run().catch((e) => { console.error('[undeliverable] ERROR:', e.message); process.exit(1); });
