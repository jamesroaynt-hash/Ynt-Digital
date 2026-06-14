// One-off targeted backfill for a single Pancake POS shop whose recent orders
// stopped syncing. Paginates orders CREATED since START straight from Pancake and
// feeds each page through posSync.receiveWebhook() (upserts pos_orders using the
// app's real logic). Writes progressively, page by page.
//
// Usage: node --experimental-sqlite backend/scripts/backfill_pos_shop.js <shopId> <apiKey> <startISO>
const fs = require('fs');
const path = require('path');
const { PostgresClient } = require('../db/client');
const posSync = require('../services/pancakePosSync');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('DATABASE_URL not found in environment or backend/.env');
}

const BASE = 'https://pos.pages.fm/api/v1';
const SHOP_ID = process.argv[2];
const API_KEY = process.argv[3];
const START = Math.floor(new Date(process.argv[4] || '2026-05-20T00:00:00Z').getTime() / 1000);
const END = Math.floor(Date.now() / 1000);
const PAGE_SIZE = 100;

async function fetchPage(pageNumber) {
  const url = new URL(`${BASE}/shops/${SHOP_ID}/orders`);
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('page_number', String(pageNumber));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('startDateTime', String(START));
  url.searchParams.set('endDateTime', String(END));
  url.searchParams.set('include_removed', '1');
  url.searchParams.set('option_sort', 'inserted_at_desc');
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Pancake page ${pageNumber} failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

async function run() {
  if (!SHOP_ID || !API_KEY) throw new Error('Usage: backfill_pos_shop.js <shopId> <apiKey> [startISO]');
  const db = new PostgresClient(loadDatabaseUrl());
  const before = await db.prepare("SELECT COUNT(*) AS c, MAX(raw_payload::jsonb ->> 'inserted_at') AS newest FROM pos_orders WHERE shop_id = ?").get(SHOP_ID);
  console.log(`[backfill ${SHOP_ID}] BEFORE: ${before.c} orders, newest real inserted_at ${before.newest}`);

  let page = 1, totalStored = 0;
  while (true) {
    const items = await fetchPage(page);
    if (!items.length) break;
    const result = await posSync.receiveWebhook(db, { shop_id: SHOP_ID, data: items });
    totalStored += result.stored || 0;
    console.log(`[backfill ${SHOP_ID}] page ${page}: fetched ${items.length}, stored ${result.stored} (running=${totalStored})`);
    if (items.length < PAGE_SIZE) break;
    page += 1;
  }

  const after = await db.prepare("SELECT COUNT(*) AS c, MAX(raw_payload::jsonb ->> 'inserted_at') AS newest FROM pos_orders WHERE shop_id = ?").get(SHOP_ID);
  console.log(`[backfill ${SHOP_ID}] DONE stored=${totalStored} | AFTER: ${after.c} orders, newest ${after.newest}`);
  await db.close();
}

run().catch((e) => { console.error('[backfill] ERROR:', e.message); process.exit(1); });
