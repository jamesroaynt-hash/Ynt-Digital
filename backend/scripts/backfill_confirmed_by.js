// One-off backfill for pos_orders.confirmed_by_name / confirmed_at.
//
// The column was added after ~29k orders had already synced, and raw payloads
// are not stored (POS_STORE_RAW_PAYLOADS=false), so the confirmation editor has
// to be re-read from Pancake. Pages every shop's order history, pulls the move
// to status 1 (Confirmed) out of each order's status_history, and writes only
// those two columns on rows that don't have them yet — a targeted UPDATE rather
// than a full re-upsert, so nothing else on the row is touched.
//
// Usage: node backend/scripts/backfill_confirmed_by.js [shopId]
const fs = require('fs');
const path = require('path');
const { PostgresClient } = require('../db/client');

const PAGE_SIZE = 100;
const CONFIRMED_STATUS = 1;
const ONLY_SHOP = process.argv[2] || null;

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL not found in environment or backend/.env');
}

// Same rule the sync uses: earliest named move to Confirmed wins.
function confirmationOf(item) {
  const history = Array.isArray(item?.status_history) ? item.status_history : [];
  const confirmations = history
    .filter((e) => Number(e?.status) === CONFIRMED_STATUS)
    .sort((a, b) => String(a?.updated_at || '').localeCompare(String(b?.updated_at || '')));
  const chosen = confirmations.find((e) => e?.name || e?.editor?.name) || confirmations[0];
  const name = String(chosen?.name || chosen?.editor?.name || '').trim();
  if (!name) return null;
  return { name, at: String(chosen?.updated_at || '').replace('T', ' ').slice(0, 19) || null };
}

async function fetchPage(baseUrl, shopId, apiKey, pageNumber) {
  const url = new URL(`${baseUrl}/shops/${shopId}/orders`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('page_number', String(pageNumber));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('include_removed', '1');
  url.searchParams.set('option_sort', 'inserted_at_desc');
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.data) ? data.data : null;
}

async function run() {
  const db = new PostgresClient(loadDatabaseUrl());
  const keys = await db.prepare(
    "SELECT name, base_url, api_key, page_id FROM integration_settings WHERE provider = 'pancake_pos' AND api_key IS NOT NULL"
  ).all();
  // oldest is the stop line: Pancake holds far more history per shop than we
  // store, and paging inserted_at_desc past our own oldest order just burns
  // requests on orders that can never match a row.
  const shops = (await db.prepare(
    `SELECT shop_id, COUNT(*) FILTER (WHERE confirmed_by_name IS NULL) AS missing,
            MIN(inserted_at_remote) AS oldest
     FROM pos_orders GROUP BY shop_id HAVING COUNT(*) FILTER (WHERE confirmed_by_name IS NULL) > 0
     ORDER BY missing DESC`
  ).all()).filter((s) => !ONLY_SHOP || String(s.shop_id) === String(ONLY_SHOP));

  console.log(`[confirmer] ${shops.length} shop(s) with rows missing a confirmer`);

  for (const shop of shops) {
    const shopId = String(shop.shop_id);
    // Prefer the connection registered for this shop; any key that can read the
    // shop works, so fall back to trying the rest.
    const ordered = [
      ...keys.filter((k) => String(k.page_id) === shopId),
      ...keys.filter((k) => String(k.page_id) !== shopId),
    ];
    let key = null;
    for (const candidate of ordered) {
      if (await fetchPage(candidate.base_url, shopId, candidate.api_key, 1)) { key = candidate; break; }
    }
    if (!key) { console.log(`[confirmer] ${shopId}: no api key can read this shop — skipped`); continue; }

    const oldest = String(shop.oldest || '').slice(0, 19);
    let page = 1;
    let updated = 0;
    let scanned = 0;
    let reachedOldest = false;
    while (true) {
      const items = await fetchPage(key.base_url, shopId, key.api_key, page);
      if (!items || !items.length) break;
      scanned += items.length;
      // Sorted inserted_at_desc, so once a page runs past our oldest stored
      // order every remaining page is older still.
      if (oldest && items.some((o) => String(o?.inserted_at || '').slice(0, 19) < oldest)) reachedOldest = true;
      // One statement per page, not per order: 29k round trips through the
      // pooler is what makes this take an hour instead of minutes.
      const values = [];
      const params = [];
      for (const item of items) {
        const confirmation = confirmationOf(item);
        if (!confirmation) continue;
        values.push('(?::text, ?::text, ?::text)');
        params.push(String(item.id), confirmation.name, confirmation.at);
      }
      if (values.length) {
        const result = await db.prepare(
          `UPDATE pos_orders SET confirmed_by_name = v.name, confirmed_at = v.at
           FROM (VALUES ${values.join(', ')}) AS v(external_id, name, at)
           WHERE pos_orders.shop_id = ? AND pos_orders.external_id = v.external_id
             AND pos_orders.confirmed_by_name IS NULL`
        ).run(...params, shopId);
        updated += Number(result?.changes || 0);
      }
      console.log(`[confirmer] ${shopId} page ${page}: scanned ${scanned}, filled ${updated}/${shop.missing}`);
      if (reachedOldest || items.length < PAGE_SIZE) break;
      page += 1;
    }
    console.log(`[confirmer] ${shopId}: DONE filled ${updated}`);
  }

  const after = await db.prepare(
    `SELECT COUNT(*) AS total, COUNT(confirmed_by_name) AS with_confirmer FROM pos_orders`
  ).get();
  console.log(`[confirmer] AFTER: ${after.with_confirmer}/${after.total} orders have a confirmer`);
  await db.close();
}

run().catch((e) => { console.error('[confirmer] ERROR:', e.message); process.exit(1); });
