import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from './db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function mask(value) {
  const text = String(value || '');
  if (!text) return 'missing';
  if (text.length <= 8) return `${text.slice(0, 2)}...`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function buildUrl(baseUrl, pathName, query = {}) {
  const url = new URL(pathName, `${baseUrl.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function getJson(url, timeoutMs = 15000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function getPosJson(baseUrl, pathName, apiKey, query = {}) {
  const primaryUrl = buildUrl(baseUrl, pathName, { ...query, api_key: apiKey });
  const primary = await getJson(primaryUrl);
  if (primary.status !== 404 || baseUrl.includes('pos.pancake.ph')) {
    return { ...primary, baseUrl };
  }

  const fallbackBaseUrl = 'https://pos.pancake.ph/api/v1';
  const fallbackUrl = buildUrl(fallbackBaseUrl, pathName, { ...query, api_key: apiKey });
  const fallback = await getJson(fallbackUrl);
  return { ...fallback, baseUrl: fallbackBaseUrl, fallbackFrom: baseUrl };
}

function summarizeBody(body) {
  if (typeof body === 'string') return body.slice(0, 180);
  if (!body || typeof body !== 'object') return typeof body;
  const keys = Object.keys(body).slice(0, 8);
  const counts = {};
  for (const key of keys) {
    if (Array.isArray(body[key])) counts[key] = body[key].length;
  }
  return { keys, counts };
}

loadEnvFile();

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'db/ynt.db');
const db = createDatabaseClient({ filename: dbPath });

try {
  const rows = await db.prepare(`
    SELECT id, connection_id, name, enabled, base_url, api_key, page_id,
           user_access_token, page_access_token, owner, botcake_token, sync_mode,
           updated_at
    FROM integration_settings
    WHERE provider = 'pancake_pos'
    ORDER BY id
  `).all();

  const connections = rows.filter((row) => stringOrNull(row.connection_id));
  const global = rows.find((row) => !stringOrNull(row.connection_id));

  console.log('=== Pancake POS Integration Diagnostic ===');
  console.log(`Database: ${db.type}${db.type === 'sqlite' ? ` (${dbPath})` : ' (DATABASE_URL)'}`);
  console.log(`Global enabled: ${Boolean(global?.enabled)} | sync_mode: ${global?.sync_mode || 'missing'}`);
  console.log(`Saved connections: ${connections.length}`);

  for (const conn of connections) {
    const name = conn.name || conn.connection_id || conn.page_id || `row-${conn.id}`;
    const baseUrl = stringOrNull(conn.base_url) || 'https://pos.pages.fm/api/v1';
    const apiKey = stringOrNull(conn.api_key);
    const shopId = stringOrNull(conn.page_id);
    const messagingPageId = stringOrNull(conn.user_access_token);
    const pageAccessToken = stringOrNull(conn.page_access_token);
    const botcakeToken = stringOrNull(conn.botcake_token);

    console.log('');
    console.log(`--- ${name} ---`);
    console.log(`enabled=${Boolean(conn.enabled)} sync_mode=${conn.sync_mode || 'missing'} owner=${conn.owner || 'missing'}`);
    console.log(`base_url=${baseUrl}`);
    console.log(`shop_id=${shopId || 'missing'} pos_token=${mask(apiKey)} pancake_page_id=${messagingPageId || 'missing'} pancake_token=${mask(pageAccessToken)} botcake_token=${mask(botcakeToken)}`);

    if (!apiKey) {
      console.log('POS API: skipped, missing POS token.');
    } else {
      try {
        const shops = await getPosJson(baseUrl, '/shops', apiKey);
        const shopCount = Array.isArray(shops.body?.shops) ? shops.body.shops.length : 0;
        console.log(`POS shops: HTTP ${shops.status}, ok=${shops.ok}, shops=${shopCount}, base=${shops.baseUrl}${shops.fallbackFrom ? ` (fallback from ${shops.fallbackFrom})` : ''}`);
        if (!shops.ok) console.log(`POS shops body: ${JSON.stringify(summarizeBody(shops.body))}`);
      } catch (error) {
        console.log(`POS shops: failed: ${error.message}`);
      }

      if (!shopId) {
        console.log('POS orders: skipped, missing shop_id.');
      } else {
        try {
          const endDateTime = Math.floor(Date.now() / 1000);
          const startDateTime = endDateTime - 7 * 24 * 60 * 60;
          const orders = await getPosJson(baseUrl, `/shops/${encodeURIComponent(shopId)}/orders`, apiKey, {
            page_number: 1,
            page_size: 1,
            startDateTime,
            endDateTime,
            include_removed: 1,
          });
          const orderCount = Array.isArray(orders.body?.data) ? orders.body.data.length : 0;
          console.log(`POS orders sample: HTTP ${orders.status}, ok=${orders.ok}, returned=${orderCount}, base=${orders.baseUrl}${orders.fallbackFrom ? ` (fallback from ${orders.fallbackFrom})` : ''}`);
          if (!orders.ok) console.log(`POS orders body: ${JSON.stringify(summarizeBody(orders.body))}`);
        } catch (error) {
          console.log(`POS orders sample: failed: ${error.message}`);
        }
      }
    }

    if (!messagingPageId || !pageAccessToken) {
      console.log('Pancake page users: skipped, missing page ID or Pancake page token.');
    } else {
      try {
        const usersUrl = `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(messagingPageId)}/users?page_access_token=${encodeURIComponent(pageAccessToken)}`;
        const users = await getJson(usersUrl);
        const active = Array.isArray(users.body?.users) ? users.body.users.length : 0;
        const disabled = Array.isArray(users.body?.disabled_users) ? users.body.disabled_users.length : 0;
        console.log(`Pancake page users: HTTP ${users.status}, ok=${users.ok}, active=${active}, disabled=${disabled}`);
        if (!users.ok) console.log(`Pancake page users body: ${JSON.stringify(summarizeBody(users.body))}`);
      } catch (error) {
        console.log(`Pancake page users: failed: ${error.message}`);
      }
    }

    if (botcakeToken) {
      console.log('Botcake: token is saved, but this app does not currently call a Botcake API endpoint to validate it.');
    } else {
      console.log('Botcake: skipped, missing Botcake token.');
    }
  }

  const latestRuns = await db.prepare(`
    SELECT status, trigger_type, error_message, started_at, finished_at
    FROM integration_sync_runs
    WHERE provider = 'pancake_pos'
    ORDER BY started_at DESC
    LIMIT 5
  `).all();

  console.log('');
  console.log('Latest POS sync runs:');
  if (!latestRuns.length) {
    console.log('none');
  } else {
    for (const run of latestRuns) {
      console.log(`${run.started_at} | ${run.status} | ${run.trigger_type} | ${run.error_message || 'no error'}`);
    }
  }

  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      COUNT(DISTINCT shop_id) AS shops,
      MAX(inserted_at_remote) AS latest_inserted,
      MAX(updated_at_remote) AS latest_updated,
      MAX(updated_at) AS latest_local_update
    FROM pos_orders
  `).get();
  const byShop = await db.prepare(`
    SELECT COALESCE(page_name, shop_id, 'unknown') AS source, COUNT(*) AS count,
           MAX(inserted_at_remote) AS latest_inserted
    FROM pos_orders
    GROUP BY COALESCE(page_name, shop_id, 'unknown')
    ORDER BY count DESC
    LIMIT 10
  `).all();

  console.log('');
  console.log('Stored POS data:');
  console.log(`orders=${counts?.total_orders || 0}, shops=${counts?.shops || 0}, latest_inserted=${counts?.latest_inserted || 'none'}, latest_updated=${counts?.latest_updated || 'none'}, latest_local_update=${counts?.latest_local_update || 'none'}`);
  for (const row of byShop) {
    console.log(`${row.source}: ${row.count} orders, latest_inserted=${row.latest_inserted || 'none'}`);
  }
} finally {
  await db.close();
}
