// One-time DB correction for a Pancake POS shop whose prices arrive ×100.
// Adding a shop to PRICE_SCALE_X100_SHOPS only fixes orders imported from then
// on: the sync's skip-unchanged guard means rows already stored keep their raw
// ×100 values forever. This divides those stored rows by 100, applying exactly
// the same transform upsertOrder() applies at ingest (cod, shipping_fee, cash,
// total_discount, and the item retail_price / price / variation_info prices).
//
// Safe to re-run: each row is divided only if it still looks un-scaled, so rows
// the live sync already imported at the correct scale are left alone.
//
// Dry run:  node backend/scripts/fix_pos_price_scale.js <shopId>
// Apply:    node backend/scripts/fix_pos_price_scale.js <shopId> --apply
const fs = require('fs');
const path = require('path');
const { PostgresClient } = require('../db/client');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL not found in environment or backend/.env');
}

const SHOP_ID = process.argv[2];
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
let DIVISOR = 100;

// Mirrors the item scaling in upsertOrder(); keep the two in step.
function scaleItems(itemsJson) {
  if (!itemsJson) return itemsJson;
  let items;
  try { items = JSON.parse(itemsJson); } catch { return itemsJson; }
  if (!Array.isArray(items)) return itemsJson;
  const scaled = items.map((it) => {
    if (!it || typeof it !== 'object') return it;
    const next = { ...it };
    if (typeof next.retail_price === 'number') next.retail_price /= DIVISOR;
    if (typeof next.price === 'number') next.price /= DIVISOR;
    if (next.variation_info && typeof next.variation_info === 'object') {
      const vi = { ...next.variation_info };
      if (typeof vi.retail_price === 'number') vi.retail_price /= DIVISOR;
      if (typeof vi.retail_price_original === 'number') vi.retail_price_original /= DIVISOR;
      next.variation_info = vi;
    }
    return next;
  });
  return JSON.stringify(scaled);
}

const scaleMoney = (v) => (v === null || v === undefined ? v : Number(v) / DIVISOR);

// Rows already imported at the right scale must not be divided a second time.
// A ×100 shop's raw values are two orders of magnitude above its real prices
// (₱399 arrives as 39900), so the largest money value on the row separates the
// two cleanly. Anything below this is treated as already-scaled and skipped.
const RAW_MIN = Number(process.env.POS_SCALE_RAW_MIN || 10000);

function itemPrices(itemsJson) {
  let items;
  try { items = JSON.parse(itemsJson || '[]'); } catch { return []; }
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    for (const v of [it.retail_price, it.price, it.variation_info?.retail_price, it.variation_info?.retail_price_original]) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

// null = nothing to do (all zeroes), true = still raw, false = already scaled.
function needsScaling(row) {
  const values = [row.cod, row.shipping_fee, row.cash, row.total_discount]
    .map((v) => Number(v) || 0)
    .concat(itemPrices(row.items_json));
  const max = values.reduce((a, b) => (b > a ? b : a), 0);
  if (max === 0) return null;
  return max >= RAW_MIN;
}

async function run() {
  if (!SHOP_ID) throw new Error('Usage: fix_pos_price_scale.js <shopId> [--apply]');
  const db = new PostgresClient(loadDatabaseUrl());

  // Pancake reports the scale as the shop's currency ("PHP100" vs "PHP"), the
  // same signal posPriceDivisor() uses. Refuse a shop that reports plain pesos
  // so this can't be pointed at correctly-priced rows and divide them to 1/100.
  const shop = await db.prepare('SELECT name, currency FROM pos_shops WHERE external_id = ? LIMIT 1').get(SHOP_ID);
  const currency = shop?.currency || null;
  const match = /^[A-Za-z]{3}(\d+)$/.exec(String(currency || '').trim());
  if (match) {
    DIVISOR = Number(match[1]);
  } else if (!FORCE) {
    throw new Error(
      `shop ${SHOP_ID} (${shop?.name || 'unknown'}) reports currency ${JSON.stringify(currency)}, `
      + 'which is not a ×N scale. Sync shops first so the currency is stored, or pass --force if you are certain.'
    );
  }
  console.log(`[scale ${SHOP_ID}] ${shop?.name || 'unknown shop'}, currency ${currency || 'unknown'}, divisor ${DIVISOR}`);
  console.log(`[scale] skipping any row whose largest money value is already below ${RAW_MIN}`);

  const rows = await db.prepare(
    'SELECT id, external_id, cod, shipping_fee, cash, total_discount, items_json FROM pos_orders WHERE shop_id = ? ORDER BY id'
  ).all(SHOP_ID);
  console.log(`[scale ${SHOP_ID}] ${rows.length} orders found; ${APPLY ? 'APPLYING' : 'DRY RUN'}`);
  if (!rows.length) { await db.close(); return; }

  let changed = 0;
  let alreadyScaled = 0;
  let empty = 0;
  for (const row of rows) {
    const verdict = needsScaling(row);
    if (verdict === null) { empty += 1; continue; }
    if (verdict === false) { alreadyScaled += 1; continue; }
    const nextItems = scaleItems(row.items_json);
    const next = {
      cod: scaleMoney(row.cod),
      shipping_fee: scaleMoney(row.shipping_fee),
      cash: scaleMoney(row.cash),
      total_discount: scaleMoney(row.total_discount),
      items_json: nextItems,
    };
    if (changed < 3) {
      console.log(`  e.g. order ${row.external_id}: cod ${row.cod} -> ${next.cod}`);
    }
    if (APPLY) {
      await db.prepare(
        'UPDATE pos_orders SET cod = ?, shipping_fee = ?, cash = ?, total_discount = ?, items_json = ?, updated_at = NOW() WHERE id = ?'
      ).run(next.cod, next.shipping_fee, next.cash, next.total_discount, next.items_json, row.id);
    }
    changed += 1;
  }

  console.log(`[scale ${SHOP_ID}] ${APPLY ? 'updated' : 'would update'} ${changed} orders`
    + ` | left alone: ${alreadyScaled} already at the right scale, ${empty} with no money values`);
  if (APPLY) {
    const after = await db.prepare(
      'SELECT MIN(cod) AS mn, MAX(cod) AS mx, ROUND(AVG(cod),2) AS avg FROM pos_orders WHERE shop_id = ?'
    ).get(SHOP_ID);
    console.log(`[scale ${SHOP_ID}] AFTER: cod min ${after.mn}, max ${after.mx}, avg ${after.avg}`);
  }
  await db.close();
}

run().catch((e) => { console.error('[scale] ERROR:', e.message); process.exit(1); });
