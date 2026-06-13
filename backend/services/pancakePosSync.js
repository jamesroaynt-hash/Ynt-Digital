const PROVIDER = 'pancake_pos';
const POS_API_BASE = 'https://pos.pages.fm/api/v1';
const DEFAULT_RESOURCES = ['orders'];

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value, fallback = null) {
  if (!value) return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizeConnection(value = {}, fallback = {}) {
  const apiKey = stringOrNull(value.api_key || value.apiKey || fallback.api_key);
  const shopId = stringOrNull(value.shop_id || value.shopId || value.page_id || fallback.shop_id);
  return {
    id: stringOrNull(value.id || value.connection_id || value.name || shopId) || `pos-${Date.now()}`,
    name: stringOrNull(value.name || value.label || fallback.name) || (shopId ? `POS ${shopId}` : 'Pancake POS'),
    enabled: value.enabled ?? fallback.enabled ?? true,
    sync_mode: stringOrNull(value.sync_mode || value.syncMode || fallback.sync_mode) || 'pull_only',
    base_url: stringOrNull(value.base_url || value.baseUrl || fallback.base_url) || POS_API_BASE,
    api_key: apiKey,
    shop_id: shopId,
    // Pancake messaging API — for users list and staff statistics
    messaging_page_id: stringOrNull(value.messaging_page_id || value.messagingPageId || fallback.messaging_page_id) || null,
    page_access_token: stringOrNull(value.page_access_token || value.pageAccessToken || fallback.page_access_token) || null,
    owner: stringOrNull(value.owner || fallback.owner) || null,
    botcake_token: stringOrNull(value.botcake_token || value.botcakeToken || fallback.botcake_token) || null,
    notes: stringOrNull(value.notes || fallback.notes) || '',
  };
}

function rowToConnection(row) {
  return {
    id: stringOrNull(row.connection_id) || 'default',
    name: stringOrNull(row.name) || `POS ${row.page_id || row.id}`,
    enabled: Boolean(row.enabled),
    sync_mode: stringOrNull(row.sync_mode) || 'pull_only',
    base_url: stringOrNull(row.base_url) || POS_API_BASE,
    api_key: stringOrNull(row.api_key),
    shop_id: stringOrNull(row.page_id),
    messaging_page_id: stringOrNull(row.user_access_token),
    page_access_token: stringOrNull(row.page_access_token),
    owner: stringOrNull(row.owner),
    botcake_token: stringOrNull(row.botcake_token),
    notes: stringOrNull(row.notes) || '',
    webhook_secret: stringOrNull(row.webhook_secret),
  };
}

function publicConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    enabled: Boolean(connection.enabled),
    sync_mode: connection.sync_mode,
    base_url: connection.base_url,
    shop_id: connection.shop_id,
    has_api_key: Boolean(connection.api_key),
    has_page_token: Boolean(connection.page_access_token),
    has_botcake_token: Boolean(connection.botcake_token),
    messaging_page_id: connection.messaging_page_id || null,
    owner: connection.owner || null,
    last_synced_at: connection.last_synced_at || null,
    notes: connection.notes || '',
  };
}

function shouldStoreRawPayloads() {
  return process.env.POS_STORE_RAW_PAYLOADS !== 'false';
}

function rawPayloadForStorage(value) {
  return shouldStoreRawPayloads() ? safeJson(value) : '{}';
}

function truncate(value, length = 500) {
  if (!value) return null;
  const text = String(value);
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function stableKey(...parts) {
  return parts
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => String(value).trim())
    .join(':');
}

function looksLikeTrackingNumber(value) {
  const text = stringOrNull(value);
  if (!text) return false;
  if (/pancake\s*pos/i.test(text)) return false;
  if (/^shop\s+\d+$/i.test(text)) return false;
  if (/^[a-f0-9-]{24,}$/i.test(text)) return false;
  return /[A-Za-z0-9]/.test(text) && text.length >= 5;
}

function firstTrackingValue(...values) {
  return values.map(stringOrNull).find(looksLikeTrackingNumber) || null;
}

function unixSecondsFromDate(value, endOfDay = false) {
  const date = value ? new Date(value) : new Date();
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

async function getSetting(db) {
  return await db.prepare("SELECT * FROM integration_settings WHERE provider = ? AND connection_id = ''").get(PROVIDER) || null;
}

async function saveSetting(db, payload) {
  const current = await getSetting(db);

  // Upsert global provider row (connection_id = '')
  const globalData = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    base_url: payload.base_url ?? current?.base_url ?? POS_API_BASE,
    webhook_secret: payload.webhook_secret ?? current?.webhook_secret ?? null,
    sync_mode: payload.sync_mode ?? current?.sync_mode ?? 'pull_only',
    notes: payload.notes ?? current?.notes ?? null,
  };

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, webhook_secret = ?, sync_mode = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ? AND connection_id = ''
    `).run(
      boolToInt(globalData.enabled), globalData.base_url, globalData.webhook_secret,
      globalData.sync_mode, globalData.notes, PROVIDER
    );
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (provider, connection_id, enabled, base_url, webhook_secret, sync_mode, notes)
      VALUES (?, '', ?, ?, ?, ?, ?)
    `).run(
      PROVIDER, boolToInt(globalData.enabled), globalData.base_url,
      globalData.webhook_secret, globalData.sync_mode, globalData.notes
    );
  }

  // Upsert individual connection rows
  if (Array.isArray(payload.connections)) {
    const currentConnections = await getSavedConnections(db);
    for (const [index, connPayload] of payload.connections.entries()) {
      const shopId = stringOrNull(connPayload.shop_id || connPayload.shopId || connPayload.page_id);
      const connId = stringOrNull(connPayload.id || connPayload.connection_id);
      if (!connId || !shopId) continue;
      const existing = currentConnections.find((c) => c.id === connId || (shopId && c.shop_id === shopId));
      const conn = normalizeConnection(connPayload, existing || { name: `POS ${index + 1}` });
      await db.prepare(`
        INSERT INTO integration_settings
          (provider, connection_id, name, enabled, base_url, api_key, page_id, page_access_token, user_access_token, owner, botcake_token, sync_mode, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection_id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          base_url = excluded.base_url,
          api_key = COALESCE(excluded.api_key, integration_settings.api_key),
          page_id = excluded.page_id,
          page_access_token = COALESCE(excluded.page_access_token, integration_settings.page_access_token),
          user_access_token = excluded.user_access_token,
          owner = excluded.owner,
          botcake_token = COALESCE(excluded.botcake_token, integration_settings.botcake_token),
          sync_mode = excluded.sync_mode,
          notes = excluded.notes,
          updated_at = datetime('now')
      `).run(
        PROVIDER, conn.id, conn.name, boolToInt(conn.enabled), conn.base_url,
        conn.api_key, conn.shop_id, conn.page_access_token, conn.messaging_page_id,
        conn.owner, conn.botcake_token, conn.sync_mode, conn.notes
      );
    }
  }

  invalidateSavedConnectionsCache();
  return await getPublicSetting(db);
}

async function getPublicSetting(db) {
  const setting = await getSetting(db);
  const connections = await getSavedConnections(db);
  const lastSyncRows = connections.length
    ? await db.prepare(`
      SELECT shop_id, MAX(updated_at) AS last_synced_at
      FROM pos_orders
      WHERE shop_id IS NOT NULL AND shop_id != ''
      GROUP BY shop_id
    `).all()
    : [];
  const lastSyncByShop = new Map(lastSyncRows.map((row) => [String(row.shop_id), row.last_synced_at]));

  if (!setting && connections.length === 0) {
    return {
      provider: PROVIDER,
      configured: false,
      enabled: false,
      base_url: POS_API_BASE,
      sync_mode: 'pull_only',
      notes: null,
      webhook_secret: null,
      connections: [],
      connection_count: 0,
    };
  }

  return {
    provider: PROVIDER,
    configured: true,
    enabled: Boolean(setting?.enabled),
    base_url: setting?.base_url || POS_API_BASE,
    sync_mode: setting?.sync_mode || 'pull_only',
    notes: setting?.notes || null,
    webhook_secret: setting?.webhook_secret || null,
    connections: connections.map((connection) => publicConnection({
      ...connection,
      last_synced_at: lastSyncByShop.get(String(connection.shop_id)) || null,
    })),
    connection_count: connections.length,
    updated_at: setting?.updated_at,
  };
}

// Short-TTL cache for getSavedConnections. The list is read once per POS order
// during sync (extractPosOrderSummary + getResolvedPosOrderSourceName), so the
// uncached version fired ~80k SELECT * /day. Connections change only when an
// admin edits config, so a few-second staleness window is fine — and writes
// (saveSetting, webhook upsert in saveSetting's connections loop) call
// invalidateSavedConnectionsCache() to drop the cache immediately.
const SAVED_CONNECTIONS_TTL_MS = 30_000;
let savedConnectionsCache = { expiresAt: 0, promise: null };

function invalidateSavedConnectionsCache() {
  savedConnectionsCache = { expiresAt: 0, promise: null };
}

async function getSavedConnections(db) {
  const now = Date.now();
  if (savedConnectionsCache.promise && savedConnectionsCache.expiresAt > now) {
    return savedConnectionsCache.promise;
  }
  const promise = (async () => {
    const rows = await db.prepare(
      "SELECT * FROM integration_settings WHERE provider = ? AND connection_id != '' ORDER BY id"
    ).all(PROVIDER);
    return rows.map(rowToConnection).filter((c) => c.api_key && c.shop_id);
  })().catch((err) => {
    invalidateSavedConnectionsCache();
    throw err;
  });
  savedConnectionsCache = { expiresAt: now + SAVED_CONNECTIONS_TTL_MS, promise };
  return promise;
}

async function startRun(db, triggerType, payloadSummary) {
  const result = await db.prepare(`
    INSERT INTO integration_sync_runs (provider, direction, trigger_type, payload_summary)
    VALUES (?, 'inbound', ?, ?)
  `).run(PROVIDER, triggerType, safeJson(payloadSummary));

  return Number(result.lastInsertRowid);
}

async function finishRun(db, runId, status, resultSummary, errorMessage) {
  await db.prepare(`
    UPDATE integration_sync_runs
    SET status = ?, result_summary = ?, error_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, safeJson(resultSummary), errorMessage || null, runId);
}

async function getLastSuccessfulSyncTime(db) {
  const row = await db.prepare(`
    SELECT finished_at FROM integration_sync_runs
    WHERE provider = ? AND status IN ('success', 'partial')
    ORDER BY finished_at DESC LIMIT 1
  `).get(PROVIDER);
  if (!row?.finished_at) return null;
  return Math.floor(new Date(row.finished_at).getTime() / 1000);
}

async function upsertSourceLink(db, entityType, externalId, localTable, localId) {
  if (!externalId || !localId) return;
  await db.prepare(`
    INSERT INTO integration_source_links (provider, entity_type, external_id, local_table, local_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, entity_type, external_id) DO UPDATE SET
      local_table = excluded.local_table,
      local_id = excluded.local_id,
      last_synced_at = datetime('now')
    WHERE integration_source_links.local_table IS DISTINCT FROM excluded.local_table
       OR integration_source_links.local_id    IS DISTINCT FROM excluded.local_id
  `).run(PROVIDER, entityType, String(externalId), localTable, String(localId));
}

async function findLinkedLocalId(db, entityType, externalId) {
  if (!externalId) return null;
  const row = await db.prepare(`
    SELECT local_id
    FROM integration_source_links
    WHERE provider = ? AND entity_type = ? AND external_id = ?
  `).get(PROVIDER, entityType, String(externalId));
  return row?.local_id || null;
}

function buildUrl(baseUrl, path, query = {}) {
  const normalizedBase = `${String(baseUrl || POS_API_BASE).replace(/\/+$/, '')}/`;
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(normalizedPath, normalizedBase);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(path, timeoutMs) {
  return new Error(`Pancake POS API GET ${path} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

function withRequestTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function shouldRetryPosRequest(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function posRequest(baseUrl, path, apiKey, query = {}, attempt = 1) {
  if (!apiKey) throw new Error('Missing Pancake POS api_key.');
  const selectedBaseUrl = baseUrl || POS_API_BASE;
  const { __timeout_ms: timeoutOverride, __no_retry: noRetry, ...apiQuery } = query || {};
  const timeoutMs = Math.max(3000, Number(timeoutOverride || 60000));
  const url = buildUrl(selectedBaseUrl, path, { ...apiQuery, api_key: apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await withRequestTimeout(
      fetch(url, { signal: controller.signal }),
      timeoutMs,
      () => {
        controller.abort();
        return timeoutError(url.pathname, timeoutMs);
      }
    );
  } catch (error) {
    if (error.name === 'AbortError') {
      throw timeoutError(url.pathname, timeoutMs);
    }
    // Node fetch (undici) reports "terminated" when the server closes the connection mid-stream
    const msg = String(error.message || error.cause?.message || '').toLowerCase();
    if (!noRetry && (msg.includes('terminated') || msg.includes('econnreset') || msg.includes('socket hang up')) && attempt < 4) {
      clearTimeout(timeout);
      await sleep(1000 * attempt);
      return posRequest(baseUrl, path, apiKey, query, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await withRequestTimeout(
    response.text(),
    timeoutMs,
    () => {
      controller.abort();
      return timeoutError(url.pathname, timeoutMs);
    }
  );
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const fallbackBaseUrl = selectedBaseUrl.includes('pos.pancake.ph')
      ? POS_API_BASE
      : 'https://pos.pancake.ph/api/v1';
    if (response.status === 404 && fallbackBaseUrl !== selectedBaseUrl) {
      return posRequest(fallbackBaseUrl, path, apiKey, query);
    }

    if (!noRetry && shouldRetryPosRequest(response.status) && attempt < 3) {
      await sleep(750 * attempt);
      return posRequest(baseUrl, path, apiKey, query, attempt + 1);
    }

    const details = typeof data === 'string' ? data : safeJson(data);
    throw new Error(`Pancake POS API GET ${url.pathname} failed (${response.status}): ${details}`);
  }

  return data;
}

async function upsertShop(db, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  await db.prepare(`
    INSERT INTO pos_shops (external_id, name, avatar_url, pages_json, link_post_marketer_json, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      name = COALESCE(excluded.name, pos_shops.name),
      avatar_url = excluded.avatar_url,
      pages_json = excluded.pages_json,
      link_post_marketer_json = excluded.link_post_marketer_json,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(item?.name),
    stringOrNull(item?.avatar_url),
    safeJson(item?.pages || []),
    safeJson(item?.link_post_marketer || []),
    rawPayloadForStorage(item)
  );
  invalidateStoredShopCache(externalId);
  return externalId;
}

async function upsertWarehouse(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  await db.prepare(`
    INSERT INTO pos_warehouses (
      external_id, shop_id, name, address, full_address, phone_number, country_code, allow_create_order, custom_id, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      name = excluded.name,
      address = excluded.address,
      full_address = excluded.full_address,
      phone_number = excluded.phone_number,
      country_code = excluded.country_code,
      allow_create_order = excluded.allow_create_order,
      custom_id = excluded.custom_id,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(shopId || item?.shop_id),
    stringOrNull(item?.name),
    stringOrNull(item?.address),
    stringOrNull(item?.full_address),
    stringOrNull(item?.phone_number),
    stringOrNull(item?.country_code),
    boolToInt(item?.allow_create_order),
    stringOrNull(item?.custom_id),
    rawPayloadForStorage(item)
  );
  return externalId;
}

const PANCAKE_STATUS_NAME = {
  0: 'new', 1: 'submitted', 2: 'shipped', 3: 'delivered',
  4: 'returning', 5: 'returned', 6: 'canceled', 7: 'removed',
  9: 'pending', 12: 'wait_print',
};

async function upsertOrder(db, shopId, item, connectionName = null) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  // Dashboard scope is 2026+. The Pancake "updated_at" fetch pass otherwise
  // back-hauls years of history (orders with old inserted_at but recent
  // updates), bloating the DB. Never store orders created before POS_MIN_DATE.
  const POS_MIN_DATE = process.env.POS_MIN_DATE || '2026-01-01';
  const insertedAtNorm = normalizePosTimestamp(item?.inserted_at || item?.created_at);
  if (insertedAtNorm && String(insertedAtNorm).slice(0, 10) < POS_MIN_DATE) return null;
  const statusNum = numberOrNull(item?.status);
  const statusName = stringOrNull(item?.status_name || item?.status_text)
    || (statusNum !== null ? (PANCAKE_STATUS_NAME[statusNum] ?? null) : null);
  if (!statusName) return null;
  if (statusName === 'canceled' || statusName === 'removed') {
    await db.prepare('DELETE FROM pos_orders WHERE shop_id = ? AND external_id = ?').run(
      stringOrNull(item?.shop_id || item?.shop?.id || item?.page_id) || shopId, String(item.id)
    );
    return null;
  }
  const customerName = getPosCustomerName(item, item?.shipping_address || {});
  const customerPhone = getPosCustomerPhone(item, item?.shipping_address || {});
  if (!customerName && !customerPhone) return null;

  const partner = item?.partner || {};
  const shippingAddress = item?.shipping_address || {};
  const trackingNo = getPosTrackingNumber(item, partner, shippingAddress);
  const attempts = extractAttemptNumber(item, getPosOrderTags(item));
  const { name: sprinterName, tel: sprinterTel } = getPosSprintorInfo(item);

  const resolvedShopId = stringOrNull(shopId || item?.shop_id || item?.shop?.id || item?.page_id || 'unknown');

  // Botcake messaging fields: the recipient PSID and page id live in the order
  // payload. conversation_id (and customer.fb_id) are formatted `{page_id}_{psid}`,
  // so the bare PSID is the part after the first underscore.
  const psid = derivePosPsid(item);
  const botcakePageId = stringOrNull(item?.account) || stringOrNull(item?.page_id);

  const rawItems = item?.order_details || item?.items || [];
  // Product name lives in variation_info.name. note_product is a free-text note
  // that sometimes holds a long marketing description, so use it only as a last
  // resort to avoid showing a paragraph instead of the product name.
  const firstItem = rawItems[0] || {};
  const noteProduct = stringOrNull(firstItem?.variation_info?.name)
    || stringOrNull(firstItem?.product_name)
    || stringOrNull(firstItem?.product?.name)
    || stringOrNull(firstItem?.name)
    || stringOrNull(firstItem?.note_product);

  // Egress saver: the interval "updated_at" pass re-fetches the same recent
  // orders every cycle (created=0, updated=2000), so without this guard we
  // re-ship the full row (items/tags/partner/shipping JSON + raw_payload) to
  // Postgres on every sync — the dominant Railway->Supabase egress. If the
  // order's remote updated_at AND resolved status already match what we stored,
  // nothing changed on Pancake, so skip the write. Real status changes bump
  // updated_at on Pancake's side, so they still flow through. Exceptions: if we
  // don't yet have the PSID stored, or the stored product name is stale, allow
  // the write so those fields backfill (one-time per order).
  const incomingUpdatedAtRemote = normalizePosTimestamp(item?.updated_at);
  if (incomingUpdatedAtRemote) {
    const stored = await db.prepare(
      'SELECT updated_at_remote, status_name, psid, note_product FROM pos_orders WHERE shop_id = ? AND external_id = ?'
    ).get(resolvedShopId, externalId);
    const psidAlreadyStored = stored && (stored.psid || !psid);
    const productUnchanged = stored && (stored.note_product === noteProduct);
    if (stored && stored.updated_at_remote === incomingUpdatedAtRemote && stored.status_name === statusName && psidAlreadyStored && productUnchanged) {
      return externalId; // unchanged — no write needed
    }
  }

  const pageName = connectionName || await findSavedConnectionName(db, resolvedShopId);
  const rawSeller = item?.assigning_seller
    || rawItems[0]?.assigning_seller
    || null;
  const assigningSeller = (rawSeller?.id || rawSeller?.name) ? rawSeller : null;
  let assignedUserId = stringOrNull(assigningSeller?.id);
  if (!assignedUserId) {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawUser = getPosConfirmedBy(item);
    if (rawUser && UUID_RE.test(rawUser)) {
      assignedUserId = rawUser;
    }
  }

  await db.prepare(`
    INSERT INTO pos_orders (
      external_id, shop_id, inserted_at_remote, updated_at_remote, status, status_name, customer_name, customer_phone,
      customer_email, page_id, shipping_fee, cod, cash, total_discount, note, attempts, tracking_no,
      note_product, page_name, assigned_user_id, assigning_seller_name, sprinter_name, sprinter_tel,
      items_json, tags_json, partner_json, shipping_address_json, psid, botcake_page_id, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      inserted_at_remote = COALESCE(excluded.inserted_at_remote, pos_orders.inserted_at_remote),
      updated_at_remote = excluded.updated_at_remote,
      status = excluded.status,
      status_name = COALESCE(excluded.status_name, pos_orders.status_name),
      customer_name = COALESCE(excluded.customer_name, pos_orders.customer_name),
      customer_phone = COALESCE(excluded.customer_phone, pos_orders.customer_phone),
      customer_email = COALESCE(excluded.customer_email, pos_orders.customer_email),
      page_id = excluded.page_id,
      shipping_fee = excluded.shipping_fee,
      cod = excluded.cod,
      cash = excluded.cash,
      total_discount = excluded.total_discount,
      note = excluded.note,
      attempts = excluded.attempts,
      tracking_no = COALESCE(excluded.tracking_no, pos_orders.tracking_no),
      note_product = excluded.note_product,
      page_name = COALESCE(excluded.page_name, pos_orders.page_name),
      assigned_user_id = COALESCE(excluded.assigned_user_id, pos_orders.assigned_user_id),
      assigning_seller_name = COALESCE(excluded.assigning_seller_name, pos_orders.assigning_seller_name),
      sprinter_name = COALESCE(excluded.sprinter_name, pos_orders.sprinter_name),
      sprinter_tel = COALESCE(excluded.sprinter_tel, pos_orders.sprinter_tel),
      items_json = excluded.items_json,
      tags_json = excluded.tags_json,
      partner_json = excluded.partner_json,
      shipping_address_json = excluded.shipping_address_json,
      psid = COALESCE(excluded.psid, pos_orders.psid),
      botcake_page_id = COALESCE(excluded.botcake_page_id, pos_orders.botcake_page_id),
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    resolvedShopId,
    normalizePosTimestamp(item?.inserted_at),
    normalizePosTimestamp(item?.updated_at),
    numberOrNull(item?.status),
    // Store the resolved status name (with numeric→name fallback) so orders that
    // arrive with only a numeric status still map to a real status instead of
    // landing in 'Other' on the RMO dashboard.
    statusName,
    customerName,
    customerPhone,
    stringOrNull(item?.bill_email || item?.customer?.email || item?.email),
    stringOrNull(item?.page_id),
    numberOrNull(item?.shipping_fee),
    numberOrNull(item?.cod),
    numberOrNull(item?.cash),
    numberOrNull(item?.total_discount),
    stringOrNull(item?.note),
    attempts,
    trackingNo || null,
    noteProduct,
    pageName || null,
    assignedUserId,
    stringOrNull(assigningSeller?.name),
    sprinterName,
    sprinterTel,
    safeJson(item?.order_details || item?.items || item?.products || item?.variations || item?.order_items || item?.line_items || []),
    safeJson(item?.tags || item?.customer_tags || []),
    safeJson(partner || null),
    safeJson(shippingAddress || null),
    psid,
    botcakePageId,
    rawPayloadForStorage(item)
  );
  return externalId;
}

// Pancake stores the Messenger conversation as `{page_id}_{psid}` in
// conversation_id (and customer.fb_id). Botcake's send API addresses the
// recipient by the bare PSID, so return the part after the first underscore.
function derivePosPsid(item = {}) {
  const conv = stringOrNull(item?.conversation_id)
    || stringOrNull(item?.customer?.fb_id)
    || stringOrNull(item?.customer?.psid);
  if (!conv) return null;
  const idx = conv.indexOf('_');
  const psid = idx >= 0 ? conv.slice(idx + 1) : conv;
  return /^\d{5,}$/.test(psid) ? psid : null;
}

async function upsertProduct(db, shopId, item) {
  const productId = stringOrNull(item?.product_id || item?.id);
  const variationId = stringOrNull(item?.variation_id || item?.id);
  const externalKey = stableKey(shopId, productId, variationId || item?.barcode || item?.custom_id || item?.name);
  if (!externalKey) return null;
  await db.prepare(`
    INSERT INTO pos_products (
      external_key, shop_id, product_id, variation_id, name, sku, barcode, custom_id, category_name,
      retail_price, imported_price, available_quantity, warehouse_json, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      shop_id = excluded.shop_id,
      product_id = excluded.product_id,
      variation_id = excluded.variation_id,
      name = excluded.name,
      sku = excluded.sku,
      barcode = excluded.barcode,
      custom_id = excluded.custom_id,
      category_name = excluded.category_name,
      retail_price = excluded.retail_price,
      imported_price = excluded.imported_price,
      available_quantity = excluded.available_quantity,
      warehouse_json = excluded.warehouse_json,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    stringOrNull(shopId),
    productId,
    variationId,
    stringOrNull(item?.name || item?.product_name),
    stringOrNull(item?.sku),
    stringOrNull(item?.barcode),
    stringOrNull(item?.custom_id),
    stringOrNull(item?.category_name || item?.category?.name),
    numberOrNull(item?.retail_price),
    numberOrNull(item?.last_imported_price || item?.average_imported_price),
    numberOrNull(item?.remain_quantity || item?.available_quantity || item?.quantity),
    safeJson(item?.warehouse || item?.warehouses || null),
    rawPayloadForStorage(item)
  );
  return externalKey;
}

async function upsertCustomer(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  await db.prepare(`
    INSERT INTO pos_customers (
      external_id, shop_id, name, phone_number, email, address, city, district, ward, level_name, note, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      name = excluded.name,
      phone_number = excluded.phone_number,
      email = excluded.email,
      address = excluded.address,
      city = excluded.city,
      district = excluded.district,
      ward = excluded.ward,
      level_name = excluded.level_name,
      note = excluded.note,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(shopId || item?.shop_id),
    stringOrNull(item?.name),
    stringOrNull(item?.phone_number || item?.phone),
    stringOrNull(item?.email),
    stringOrNull(item?.address),
    stringOrNull(item?.city),
    stringOrNull(item?.district),
    stringOrNull(item?.ward),
    stringOrNull(item?.level_name || item?.customer_level?.name),
    stringOrNull(item?.note),
    rawPayloadForStorage(item)
  );
  return externalId;
}

async function upsertUser(db, shopId, item) {
  const externalId = stringOrNull(item?.id || item?.user_id || item?.account_id);
  const externalKey = stableKey(shopId, externalId || item?.email || item?.phone_number || item?.username || item?.name);
  if (!externalKey) return null;
  await db.prepare(`
    INSERT INTO pos_users (
      external_key, shop_id, external_id, name, username, email, phone_number, role_name, is_active, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      shop_id = excluded.shop_id,
      external_id = excluded.external_id,
      name = excluded.name,
      username = excluded.username,
      email = excluded.email,
      phone_number = excluded.phone_number,
      role_name = excluded.role_name,
      is_active = excluded.is_active,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    stringOrNull(shopId || item?.shop_id),
    externalId,
    stringOrNull(item?.name || item?.full_name),
    stringOrNull(item?.username || item?.account_name),
    stringOrNull(item?.email),
    stringOrNull(item?.phone_number || item?.phone),
    stringOrNull(item?.role_name || item?.role || item?.user_group || item?.permission_name),
    item?.is_active === false || item?.active === false || item?.status === false ? 0 : 1,
    rawPayloadForStorage(item)
  );
  return externalKey;
}

async function upsertTransaction(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  await db.prepare(`
    INSERT INTO pos_transactions (
      external_id, shop_id, transaction_type, status, code, value, note, inserted_at_remote, updated_at_remote, contact_name, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      transaction_type = excluded.transaction_type,
      status = excluded.status,
      code = excluded.code,
      value = excluded.value,
      note = excluded.note,
      inserted_at_remote = excluded.inserted_at_remote,
      updated_at_remote = excluded.updated_at_remote,
      contact_name = excluded.contact_name,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(shopId || item?.shop_id),
    stringOrNull(item?.transaction_type || item?.type),
    numberOrNull(item?.status),
    stringOrNull(item?.code),
    numberOrNull(item?.value || item?.amount),
    stringOrNull(item?.note),
    stringOrNull(item?.inserted_at),
    stringOrNull(item?.updated_at),
    stringOrNull(item?.contact_name || item?.partner_name),
    rawPayloadForStorage(item)
  );
  return externalId;
}

async function upsertInventoryHistory(db, shopId, item) {
  const variationId = stringOrNull(item?.variation_id);
  const productId = stringOrNull(item?.product_id);
  const externalKey = stableKey(shopId, variationId, productId, item?.inserted_at, item?.action_type, item?.changed_quantity);
  if (!externalKey) return null;
  await db.prepare(`
    INSERT INTO pos_inventory_histories (
      external_key, shop_id, variation_id, product_id, action_type, changed_quantity, avg_price,
      warehouse_json, current_inventory_json, inserted_at_remote, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      shop_id = excluded.shop_id,
      variation_id = excluded.variation_id,
      product_id = excluded.product_id,
      action_type = excluded.action_type,
      changed_quantity = excluded.changed_quantity,
      avg_price = excluded.avg_price,
      warehouse_json = excluded.warehouse_json,
      current_inventory_json = excluded.current_inventory_json,
      inserted_at_remote = excluded.inserted_at_remote,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    stringOrNull(shopId),
    variationId,
    productId,
    stringOrNull(item?.action_type || item?.type),
    numberOrNull(item?.changed_quantity || item?.quantity),
    numberOrNull(item?.avg_price),
    safeJson(item?.warehouse || null),
    safeJson(item?.current_inventory || []),
    stringOrNull(item?.inserted_at || item?.created_at),
    rawPayloadForStorage(item)
  );
  return externalKey;
}

function normalizeDateString(value) {
  const str = String(value || '');
  // A bare calendar date (e.g. Google Sheets "2026-06-04") is already local —
  // trust it as-is. Only strings WITH a time component need TZ conversion.
  const bareDate = str.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (bareDate) return bareDate[1];

  // Resolve to an epoch (handles ISO strings and Unix second/ms integers).
  let ms;
  const num = Number(str);
  if (str && !Number.isNaN(num) && num > 1_000_000_000) {
    ms = num > 9_999_999_999 ? num : num * 1000;
  } else {
    const parsed = str ? new Date(str) : new Date();
    ms = Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
  }

  // Express the calendar date in Manila time. POS timestamps are UTC, so a plain
  // UTC slice rolled PH early-morning orders back a day and hid them from the
  // (Manila-local) "Today" filter.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

// Converts a POS timestamp (ISO string or Unix ms/s integer) to "YYYY-MM-DD HH:MM:SS" for storage.
function normalizePosTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isNaN(num) && num > 1_000_000_000) {
    const ms = num > 9_999_999_999 ? num : num * 1000;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
  return String(value).trim() || null;
}

function getPartnerShipmentStatus(partner = {}) {
  const ps = String(partner?.partner_status || '').toLowerCase();
  if (ps === 'delivered') return 'Delivered';
  if (ps === 'returned') return 'Returned';
  if (ps === 'returning' || ps === 'undeliverable') return 'Returning';
  if (ps === 'on_the_way' || ps === 'out_for_delivery') return 'Shipped';
  return null;
}

function dashboardStatusFromPos(item) {
  const code = numberOrNull(item?.status);
  const partner = item?.partner || {};

  // Canceled/removed is always final — check before partner
  if (code === 6 || code === 7) return 'Canceled';
  const statusText = String(item?.status_name || item?.status_text || '').toLowerCase();
  if (statusText.includes('cancel') || statusText.includes('removed') || statusText.includes('deleted')) return 'Canceled';

  // Partner shipment status takes priority for delivery outcomes
  const partnerStatus = getPartnerShipmentStatus(partner);
  if (partnerStatus) return partnerStatus;

  // POS numeric status codes
  if (code !== null) {
    if (code === 3) return 'Delivered';
    if (code === 4) return 'Returning';
    if (code === 5 || code === 15) return 'Returned';
    if (code === 8 || code === 9 || code === 12) return 'Waiting for pickup';
    if (code === 2) return 'Shipped';
    if (code === 1 || code === 20) return 'Confirmed';
    // Pancake sometimes reports status=0 while status_name is already advanced
    // (e.g. "submitted"/confirmed). Don't let the zero code mask that — fall
    // through to the text matching below instead of forcing 'New'.
    if (code === 0 && !(statusText.includes('submit') || statusText.includes('confirm') || statusText.includes('purchased'))) {
      return 'New';
    }
  }

  // Status_name text matching
  if (statusText.includes('delivered') || statusText.includes('received') || statusText.includes('complete')) return 'Delivered';
  if (statusText.includes('returning')) return 'Returning';
  if (statusText.includes('return')) return 'Returned';
  if (statusText.includes('pickup') || statusText.includes('packaging') || statusText.includes('waiting') || statusText.includes('ready') || statusText.includes('print') || statusText.includes('pending')) return 'Waiting for pickup';
  if (statusText.includes('ship') || statusText.includes('transit')) return 'Shipped';
  if (statusText.includes('confirm') || statusText.includes('purchased') || statusText.includes('submit')) return 'Confirmed';
  if (statusText === 'new' || statusText === 'draft' || statusText === 'created') return 'New';

  // Tag-based hints
  const tags = getPosOrderTags(item);
  const tagValue = String(tags || '').toLowerCase();
  if (tagValue.includes('pickup') || tagValue.includes('waiting') || tagValue.includes('wfp') || tagValue.includes('for pick')) return 'Waiting for pickup';
  if (tagValue.includes('ship') || tagValue.includes('transit')) return 'Shipped';
  if (tagValue.includes('deliver')) return 'Delivered';
  if (tagValue.includes('return') && tagValue.includes('ing')) return 'Returning';
  if (tagValue.includes('return')) return 'Returned';
  if (tagValue.includes('cancel')) return 'Canceled';

  return 'Confirmed';
}

function getPosItemProductName(entry = {}) {
  const product = entry?.product || {};
  const variation = entry?.variation || {};
  const variationInfo = entry?.variation_info || {};
  const comboInfo = entry?.combo_product_info || {};
  return stringOrNull(
    entry?.variation_name ||
    entry?.product_name ||
    entry?.name ||
    entry?.product_display_name ||
    entry?.display_name ||
    variationInfo?.name ||
    variationInfo?.product_name ||
    variationInfo?.detail ||
    variation?.name ||
    variation?.variation_name ||
    variation?.product_name ||
    comboInfo?.name ||
    comboInfo?.product_name ||
    product?.name ||
    product?.product_name
  );
}

function getPosOrderProductName(item = {}) {
  const variationInfo = item?.variation_info || {};
  return stringOrNull(
    item?.product_name ||
    item?.product_display_name ||
    item?.variation_name ||
    variationInfo?.name ||
    variationInfo?.product_name ||
    (typeof item?.product === 'string' ? item.product : null) ||
    item?.product?.name ||
    item?.product?.product_name ||
    item?.variation?.name ||
    item?.variation?.variation_name
  );
}

function normalizePosTagValue(value) {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return stringOrNull(value);
  return stringOrNull(
    value?.name ||
    value?.tag_name ||
    value?.label ||
    value?.title ||
    value?.text ||
    value?.code ||
    value?.id
  );
}

function extractAttemptNumber(item, tags) {
  const countOfDelivery = Number(item?.partner?.count_of_delivery);
  if (Number.isFinite(countOfDelivery) && countOfDelivery >= 1) return countOfDelivery;
  if (!tags) return 1;
  const match = String(tags).match(/(\d+)\s*(?:st|nd|rd|th)\s*attempt/i);
  if (match) return Math.max(1, Number(match[1]));
  return 1;
}

function getPosOrderTags(item = {}) {
  const latestPartnerUpdate = Array.isArray(item?.partner?.extend_update)
    ? [...item.partner.extend_update].reverse().find(update => stringOrNull(update?.status))
    : null;
  const candidates = [
    item?.tags,
    item?.tag,
    item?.customer_tags,
    item?.tag_names,
    item?.tag_name,
    item?.labels,
    item?.order_tags,
    item?.customer?.tags,
    item?.shipping_address?.tags,
    item?.shipping_address?.customer_tags,
    item?.tag_names_text,
    item?.tags_text,
    latestPartnerUpdate?.status,
  ];
  const values = [];

  candidates.forEach((candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => {
        const value = normalizePosTagValue(entry);
        if (value) values.push(value);
      });
      return;
    }

    const value = normalizePosTagValue(candidate);
    if (value) values.push(value);
  });

  return [...new Set(values)].join(', ') || null;
}

function getPosConfirmedBy(item = {}) {
  const CONFIRMER_KEYS = new Set([
    'confirmed_by', 'confirmed_by_name', 'confirmer', 'confirmer_name', 'confirmed_user',
    'seller', 'seller_name', 'employee', 'employee_name', 'staff', 'staff_name',
    'created_by', 'creator', 'marketer', 'assignee',
  ]);
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) {
        const match = visit(entry);
        if (match) return match;
      }
      return null;
    }

    for (const [key, value] of Object.entries(node)) {
      if (!CONFIRMER_KEYS.has(key.toLowerCase())) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        const text = stringOrNull(value);
        if (text) return text;
      }
      const name = stringOrNull(value?.name || value?.full_name || value?.username || value?.label || value?.title);
      if (name) return name;
    }

    for (const value of Object.values(node)) {
      const match = visit(value);
      if (match) return match;
    }
    return null;
  }

  return visit(item);
}

function getPosCustomerName(item = {}, shippingAddress = {}) {
  const customer = item?.customer || {};
  return stringOrNull(
    item?.bill_full_name ||
    item?.customer_name ||
    item?.recipient_name ||
    item?.buyer_name ||
    customer?.name ||
    customer?.full_name ||
    shippingAddress?.name ||
    item?.name
  );
}

function getPosCustomerPhone(item = {}, shippingAddress = {}) {
  const customer = item?.customer || {};
  return stringOrNull(
    item?.bill_phone_number ||
    item?.customer_phone ||
    item?.phone_number ||
    item?.phone ||
    customer?.phone_number ||
    customer?.phone ||
    shippingAddress?.phone_number ||
    shippingAddress?.phone
  );
}

function getPosOrderRef(item = {}, externalId) {
  return stringOrNull(
    item?.order_ref ||
    item?.order_number ||
    item?.order_id ||
    item?.order_code ||
    item?.code ||
    item?.custom_id ||
    item?.system_id ||
    item?.display_id ||
    item?.ref ||
    item?.reference ||
    item?.bill_code ||
    item?.invoice_number ||
    item?.shipping_code
  ) || String(externalId);
}

function getPosSprintorInfo(item = {}) {
  const SPRINTER_RE = /】sprinter【([^:】]+?)\s*:\s*(\d{9,13})】/i;
  const extendUpdate = item?.partner?.extend_update;
  if (Array.isArray(extendUpdate)) {
    for (const entry of [...extendUpdate].reverse()) {
      const match = SPRINTER_RE.exec(entry?.status || '');
      if (match) return { name: match[1].trim(), tel: match[2].trim() };
    }
  }
  return { name: null, tel: null };
}

function getPosTrackingNumber(item = {}, partner = {}, shippingAddress = {}) {
  const shipping = item?.shipping || {};
  const delivery = item?.delivery || {};
  const latestPartnerUpdate = Array.isArray(partner?.extend_update)
    ? [...partner.extend_update].reverse().find(update => stringOrNull(update?.tracking_id))
    : null;
  return firstTrackingValue(
    partner?.extend_code ||
    latestPartnerUpdate?.tracking_id ||
    item?.tracking_no ||
    item?.tracking_number ||
    item?.tracking_code ||
    item?.shipping_tracking_code ||
    item?.shipping_code ||
    item?.delivery_code ||
    item?.bill_code ||
    item?.shipping_order_code ||
    item?.partner_order_code ||
    item?.partner_tracking_code ||
    partner?.tracking_no ||
    partner?.tracking_number ||
    partner?.tracking_code ||
    shipping?.tracking_no ||
    shipping?.tracking_number ||
    shipping?.tracking_code ||
    shipping?.code ||
    delivery?.tracking_no ||
    delivery?.tracking_number ||
    delivery?.tracking_code ||
    delivery?.code ||
    shippingAddress?.tracking_no ||
    shippingAddress?.tracking_number
  );
}

function getOrderItemsSummary(item) {
  const items = Array.isArray(item?.items)
    ? item.items
    : Array.isArray(item?.products)
      ? item.products
      : Array.isArray(item?.variations)
        ? item.variations
        : Array.isArray(item?.order_items)
          ? item.order_items
          : Array.isArray(item?.line_items)
            ? item.line_items
            : [];
  if (!items.length) {
    return {
      product: getPosOrderProductName(item),
      qty: Math.max(1, Math.round(numberOrNull(item?.quantity || item?.qty) || 1)),
    };
  }

  const productNames = items
    .map(getPosItemProductName)
    .filter(Boolean);
  const qty = items.reduce((sum, entry) => sum + Math.max(0, Math.round(numberOrNull(entry?.quantity || entry?.qty) || 0)), 0);
  return {
    product: productNames.length ? productNames.slice(0, 3).join(', ') : null,
    qty: Math.max(1, qty || items.length),
  };
}

function getDashboardOrderSummary(item) {
  const summary = getOrderItemsSummary(item);
  return {
    ...summary,
    product: summary.product || 'Pancake POS Order',
  };
}

function getPosOrderSourceName(shopId, item) {
  const page = item?.page || item?.fanpage || item?.facebook_page || {};
  const shop = item?.shop || {};
  const sourceName = stringOrNull(
    item?.page_name ||
    item?.fanpage_name ||
    item?.facebook_page_name ||
    item?.fb_page_name ||
    item?.source_name ||
    page?.name ||
    page?.page_name ||
    shop?.name
  );
  return sourceName || (shopId ? `Shop ${shopId}` : 'Pancake POS');
}

function getNestedValues(value, keys = []) {
  const matches = [];
  const seen = new Set();
  const keySet = new Set(keys);

  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    Object.entries(node).forEach(([key, entry]) => {
      if (keySet.has(key)) matches.push(entry);
      visit(entry);
    });
  }

  visit(value);
  return matches;
}

function getPageNameFromPayload(page) {
  return stringOrNull(
    page?.name ||
    page?.page_name ||
    page?.fanpage_name ||
    page?.facebook_page_name ||
    page?.fb_page_name ||
    page?.label ||
    page?.title
  );
}

function getPageIdFromPayload(page) {
  return stringOrNull(
    page?.id ||
    page?.page_id ||
    page?.fanpage_id ||
    page?.facebook_page_id ||
    page?.fb_page_id
  );
}

function findPageNameById(payload, pageId) {
  const target = stringOrNull(pageId);
  if (!target) return null;

  const candidates = [
    payload?.pages,
    payload?.page,
    payload?.fanpage,
    payload?.facebook_page,
    payload?.fb_page,
    payload?.data,
    ...getNestedValues(payload, ['pages', 'page', 'fanpage', 'facebook_page', 'fb_page']),
  ];

  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : [candidate];
    for (const page of list) {
      if (!page || typeof page !== 'object') continue;
      if (getPageIdFromPayload(page) === target) {
        const name = getPageNameFromPayload(page);
        if (name) return name;
      }
    }
  }

  return null;
}

// Same rationale as savedConnectionsCache above: findStoredPageName is called
// once per POS order in the sync loop (via getResolvedPosOrderSourceName), so
// without the cache it issued ~300k SELECTs/day against pos_shops. Shops change
// only when sync ingests a new one; staleness is harmless for name resolution.
const STORED_SHOP_TTL_MS = 30_000;
const storedShopCache = new Map(); // shopId -> { expiresAt, promise }

function invalidateStoredShopCache(shopId) {
  if (shopId == null) storedShopCache.clear();
  else storedShopCache.delete(String(shopId));
}

async function findStoredPageName(db, shopId, pageId) {
  if (!shopId) return null;
  const key = String(shopId);
  const now = Date.now();
  let entry = storedShopCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    const promise = db
      .prepare('SELECT name, pages_json, raw_payload FROM pos_shops WHERE external_id = ? LIMIT 1')
      .get(shopId)
      .catch((err) => { storedShopCache.delete(key); throw err; });
    entry = { expiresAt: now + STORED_SHOP_TTL_MS, promise };
    storedShopCache.set(key, entry);
  }
  const shop = await entry.promise;
  if (!shop) return null;

  const pages = parseJsonObject(shop.pages_json, []);
  const rawPayload = parseJsonObject(shop.raw_payload, {});
  return findPageNameById({ pages }, pageId)
    || findPageNameById(rawPayload, pageId)
    || stringOrNull(shop.name);
}

async function findSavedConnectionName(db, shopId) {
  const target = stringOrNull(shopId);
  if (!target) return null;

  const connections = await getSavedConnections(db);
  const match = connections.find((connection) => stringOrNull(connection.shop_id) === target);
  return stringOrNull(match?.name);
}

async function getResolvedPosOrderSourceName(db, shopId, item) {
  const page = item?.page || item?.fanpage || item?.facebook_page || {};
  const directPageName = stringOrNull(
    item?.page_name ||
    item?.fanpage_name ||
    item?.facebook_page_name ||
    item?.fb_page_name ||
    page?.name ||
    page?.page_name
  );
  if (directPageName) return directPageName;

  const pageId = stringOrNull(
    item?.page_id ||
    item?.fanpage_id ||
    item?.facebook_page_id ||
    item?.fb_page_id
  );
  const pageName = await findStoredPageName(db, shopId, pageId);
  const connectionName = await findSavedConnectionName(db, shopId);
  return pageName || connectionName || getPosOrderSourceName(shopId, item);
}

function getDashboardTransferSkipReason(item = {}) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return 'missing_external_id';
  const shippingAddress = item?.shipping_address || {};
  const customer = getPosCustomerName(item, shippingAddress);
  const phone = getPosCustomerPhone(item, shippingAddress);
  if (!customer && !phone) return 'missing_customer_and_phone';
  return null;
}

async function transferPosOrderToDashboard(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;

  const summary = getDashboardOrderSummary(item);
  const partner = item?.partner || {};
  const shippingAddress = item?.shipping_address || {};
  const orderRef = getPosOrderRef(item, externalId);
  const trackingNo = getPosTrackingNumber(item, partner, shippingAddress);

  const rawCustomer = getPosCustomerName(item, shippingAddress);
  const rawPhone = getPosCustomerPhone(item, shippingAddress);
  if (!rawCustomer && !rawPhone) return null;

  const courier = stringOrNull(
    item?.courier ||
    item?.shipping_provider ||
    item?.partner_name ||
    partner?.name ||
    partner?.partner_name ||
    partner?.shipping_partner_name
  );
  const phone = rawPhone;
  const customer = rawCustomer || `Customer (${phone})`;
  const tags = getPosOrderTags(item);
  const cod = numberOrNull(item?.cod ?? item?.cash ?? item?.total_price ?? item?.total) || 0;
  const sourceName = await getResolvedPosOrderSourceName(db, shopId, item);
  let confirmedBy = getPosConfirmedBy(item);
  // Resolve UUID to name if the confirmer was stored as a user ID
  if (confirmedBy && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(confirmedBy)) {
    const posUser = await db.prepare('SELECT name FROM pos_users WHERE external_id = ? AND name IS NOT NULL LIMIT 1').get(confirmedBy);
    if (posUser?.name) confirmedBy = posUser.name;
  }
  // Pancake reuses order ids across shops, so the dashboard link and dedup must be
  // scoped by shop — otherwise one page's order overwrites another page's order
  // that happens to share the same Pancake id (and the globally-unique orders.order_ref
  // collides on insert). Link on a shop-scoped id; fall back to matching an existing
  // row by (order_ref + same source page) so legacy bare-linked rows are re-keyed
  // without creating duplicates.
  const resolvedShopId = stringOrNull(shopId || item?.shop_id || item?.shop?.id || item?.page_id) || 'unknown';
  const linkExternalId = `${resolvedShopId}::${externalId}`;
  const orderDate = normalizeDateString(item?.inserted_at || item?.created_at || item?.updated_at);
  const status = dashboardStatusFromPos(item);

  const linkedId = await findLinkedLocalId(db, 'orders', linkExternalId);
  const existing = linkedId
    ? await db.prepare('SELECT id FROM orders WHERE id = ?').get(linkedId)
    : await db.prepare("SELECT id FROM orders WHERE order_ref = ? AND COALESCE(source_sheet,'') = COALESCE(?,'') LIMIT 1").get(orderRef, sourceName);

  const attemptNum = extractAttemptNumber(item, tags);

  if (existing) {
    await db.prepare(`
      UPDATE orders
      SET order_ref = ?, tracking_no = ?, customer = ?, phone = ?, product = ?, qty = ?, cod_amount = ?,
          status = ?, courier = ?, source_sheet = ?, confirmed_by = COALESCE(?, confirmed_by), tags = ?, attempts = ?,
          order_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      orderRef, trackingNo, customer, phone, summary.product, summary.qty, cod,
      status, courier, sourceName, confirmedBy, tags, attemptNum, orderDate, existing.id
    );
    await upsertSourceLink(db, 'orders', linkExternalId, 'orders', existing.id);
    return existing.id;
  }

  const insertOrder = (ref) => db.prepare(`
    INSERT INTO orders (order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier, source_sheet, confirmed_by, attempts, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref, trackingNo, customer, phone, summary.product, tags, summary.qty, cod,
    status, courier, sourceName, confirmedBy, attemptNum, orderDate
  );

  let result;
  try {
    result = await insertOrder(orderRef);
  } catch (err) {
    // order_ref is already taken by a different shop's order — fall back to a
    // shop-scoped ref so this order still lands instead of crashing the sync.
    result = await insertOrder(linkExternalId);
  }
  await upsertSourceLink(db, 'orders', linkExternalId, 'orders', result.lastInsertRowid);
  return result.lastInsertRowid;
}

async function transferPosProductToInventory(db, shopId, item) {
  const productId = stringOrNull(item?.product_id || item?.id);
  const variationId = stringOrNull(item?.variation_id || item?.id);
  const externalKey = stableKey(shopId, productId, variationId || item?.barcode || item?.custom_id || item?.name);
  if (!externalKey) return null;

  const itemId = `POS-${variationId || productId || externalKey}`.slice(0, 80);
  const sku = stringOrNull(item?.sku || item?.barcode || item?.custom_id) || itemId;
  const name = stringOrNull(item?.name || item?.product_name) || 'Pancake POS Product';
  const stock = Math.max(0, Math.round(numberOrNull(item?.remain_quantity || item?.available_quantity || item?.quantity) || 0));
  const cost = numberOrNull(item?.last_imported_price || item?.average_imported_price) || 0;
  const price = numberOrNull(item?.retail_price);
  const linkedId = await findLinkedLocalId(db, 'inventory', externalKey);
  const existing = linkedId
    ? await db.prepare('SELECT id, item_id, stock FROM inventory WHERE id = ?').get(linkedId)
    : await db.prepare('SELECT id, item_id, stock FROM inventory WHERE item_id = ? OR sku = ? LIMIT 1').get(itemId, sku);

  if (existing) {
    await db.prepare(`
      UPDATE inventory
      SET item_id = ?, name = ?, sku = ?, type = 'Product', unit = 'pcs', stock = ?, cost_price = ?, sell_price = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(itemId, name, sku, stock, cost, price, existing.id);
    if (Number(existing.stock) !== stock) {
      await db.prepare(`
        INSERT INTO inventory_logs (item_id, action, qty_before, qty_change, qty_after, notes)
        VALUES (?, 'set', ?, ?, ?, ?)
      `).run(existing.item_id, existing.stock, stock - existing.stock, stock, 'Pancake POS API sync');
    }
    await upsertSourceLink(db, 'inventory', externalKey, 'inventory', existing.id);
    return existing.id;
  }

  const result = await db.prepare(`
    INSERT INTO inventory (item_id, name, sku, type, unit, stock, reorder_pt, cost_price, sell_price)
    VALUES (?, ?, ?, 'Product', 'pcs', ?, 200, ?, ?)
  `).run(itemId, name, sku, stock, cost, price);
  await db.prepare(`
    INSERT INTO inventory_logs (item_id, action, qty_before, qty_change, qty_after, notes)
    VALUES (?, 'set', 0, ?, ?, ?)
  `).run(itemId, stock, stock, 'Pancake POS API import');
  await upsertSourceLink(db, 'inventory', externalKey, 'inventory', result.lastInsertRowid);
  return result.lastInsertRowid;
}

// Auto-triggers removed from storeItems / webhook / replay paths — current
// inserts no longer create the 'Pancake POS Customer' / 'Pancake POS Order'
// placeholders, so cleanup is unnecessary at sync time. The 24h throttle is a
// defensive cap in case a callsite is re-added; the manual /pos-raw/incomplete
// endpoint and the POS_CLEAN_MALFORMED_ORDERS startup flag still work.
const CLEANUP_THROTTLE_MS = 24 * 60 * 60 * 1000;
let cleanupLastRunAt = 0;
let cleanupInflight = null;

async function cleanupMalformedDashboardOrders(db, { force = false } = {}) {
  if (cleanupInflight) return cleanupInflight;
  if (!force && Date.now() - cleanupLastRunAt < CLEANUP_THROTTLE_MS) return 0;

  cleanupInflight = (async () => {
    // Remove POS-linked orders that have placeholder or missing customer/product
    // CAST is on the constant side (o.id → text) so isl.local_id stays bare
    // and idx_isl_orders_lookup (local_table, entity_type, provider, local_id) can be used.
    const result = await db.prepare(`
      DELETE FROM orders
      WHERE id IN (
        SELECT o.id
        FROM orders o
        INNER JOIN integration_source_links isl
          ON isl.provider = 'pancake_pos'
         AND isl.entity_type = 'orders'
         AND isl.local_table = 'orders'
         AND isl.local_id = CAST(o.id AS TEXT)
        WHERE o.customer = 'Pancake POS Customer'
           OR o.customer IS NULL
           OR TRIM(o.customer) = ''
           OR o.product = 'Pancake POS Order'
           OR o.product IS NULL
           OR TRIM(o.product) = ''
      )
    `).run();
    const cleaned = result.changes || 0;

    // Clean up source links pointing to deleted orders.
    // CAST moved to the subquery side so the index on local_id can still be used.
    await db.prepare(`
      DELETE FROM integration_source_links
      WHERE provider = 'pancake_pos'
        AND entity_type = 'orders'
        AND local_table = 'orders'
        AND local_id NOT IN (SELECT CAST(id AS TEXT) FROM orders)
    `).run();

    cleanupLastRunAt = Date.now();
    return cleaned;
  })().finally(() => { cleanupInflight = null; });

  return cleanupInflight;
}

async function normalizeSourceSheets(db) {
  // Unify source_sheet for all POS-linked dashboard orders that share the same shop_id + page_id,
  // using the current connection name as the canonical name.
  const connections = await getSavedConnections(db);
  let normalized = 0;
  for (const conn of connections) {
    if (!conn.shop_id || !conn.name) continue;
    const result = await db.prepare(`
      UPDATE orders
      SET source_sheet = ?, updated_at = datetime('now')
      WHERE id IN (
        SELECT CAST(isl.local_id AS INTEGER)
        FROM integration_source_links isl
        LEFT JOIN pos_orders po ON po.external_id = isl.external_id
        WHERE isl.provider = 'pancake_pos'
          AND isl.entity_type = 'orders'
          AND isl.local_table = 'orders'
          AND (po.shop_id = ? OR po.external_id IS NULL)
      )
      AND (source_sheet IS NULL OR source_sheet != ?)
    `).run(conn.name, conn.shop_id, conn.name);

    // Also normalize by shop_id suffix in source_sheet (catches "Shop 100956439" etc.)
    const shopSuffix = conn.shop_id;
    await db.prepare(`
      UPDATE orders
      SET source_sheet = ?, updated_at = datetime('now')
      WHERE source_sheet LIKE ? AND (source_sheet IS NULL OR source_sheet != ?)
    `).run(conn.name, `%${shopSuffix}%`, conn.name);
    normalized += result.changes || 0;
  }
  return normalized;
}

async function storeItems(db, resource, shopId, items, connectionName = null, options = {}) {
  const transferDashboardOrders = options.transfer_dashboard_orders === true || options.transferDashboardOrders === true;
  const localIds = [];
  for (const item of items) {
    let localId = null;
    if (resource === 'shops') localId = await upsertShop(db, item);
    if (resource === 'warehouses') localId = await upsertWarehouse(db, shopId, item);
    if (resource === 'orders') localId = await upsertOrder(db, shopId, item, connectionName);
    if (resource === 'products') localId = await upsertProduct(db, shopId, item);
    if (resource === 'customers') localId = await upsertCustomer(db, shopId, item);
    if (resource === 'users') localId = await upsertUser(db, shopId, item);
    if (resource === 'transactions') localId = await upsertTransaction(db, shopId, item);
    if (resource === 'inventory_histories') localId = await upsertInventoryHistory(db, shopId, item);
    if (resource === 'orders' && transferDashboardOrders) await transferPosOrderToDashboard(db, shopId, item);
    if (resource === 'products') await transferPosProductToInventory(db, shopId, item);
    if (localId) localIds.push(localId);
  }
  return localIds;
}

async function getCounts(db) {
  return {
    shops: (await db.prepare('SELECT COUNT(*) AS count FROM pos_shops').get()).count,
    warehouses: (await db.prepare('SELECT COUNT(*) AS count FROM pos_warehouses').get()).count,
    orders: (await db.prepare('SELECT COUNT(*) AS count FROM pos_orders').get()).count,
    products: (await db.prepare('SELECT COUNT(*) AS count FROM pos_products').get()).count,
    customers: (await db.prepare('SELECT COUNT(*) AS count FROM pos_customers').get()).count,
    users: (await db.prepare('SELECT COUNT(*) AS count FROM pos_users').get()).count,
    transactions: (await db.prepare('SELECT COUNT(*) AS count FROM pos_transactions').get()).count,
    inventory_histories: (await db.prepare('SELECT COUNT(*) AS count FROM pos_inventory_histories').get()).count,
  };
}

function storedPosOrderToPayload(row = {}) {
  const rawPayload = parseJsonObject(row.raw_payload, {});
  const rawIsUseful = rawPayload && Object.keys(rawPayload).length;
  return {
    ...(rawIsUseful ? rawPayload : {}),
    id: rawPayload?.id || row.external_id,
    shop_id: rawPayload?.shop_id || row.shop_id,
    inserted_at: rawPayload?.inserted_at || row.inserted_at_remote,
    updated_at: rawPayload?.updated_at || row.updated_at_remote,
    status: rawPayload?.status ?? row.status,
    status_name: rawPayload?.status_name || row.status_name,
    bill_full_name: rawPayload?.bill_full_name || row.customer_name,
    bill_phone_number: rawPayload?.bill_phone_number || row.customer_phone,
    bill_email: rawPayload?.bill_email || row.customer_email,
    page_id: rawPayload?.page_id || row.page_id,
    cod: rawPayload?.cod ?? row.cod,
    cash: rawPayload?.cash ?? row.cash,
    note: rawPayload?.note || row.note,
    items: Array.isArray(rawPayload?.items) ? rawPayload.items : parseJsonObject(row.items_json, []),
    tags: Array.isArray(rawPayload?.tags) ? rawPayload.tags : parseJsonObject(row.tags_json, []),
    customer_tags: Array.isArray(rawPayload?.customer_tags) ? rawPayload.customer_tags : [],
    partner: rawPayload?.partner || parseJsonObject(row.partner_json, null),
    shipping_address: rawPayload?.shipping_address || parseJsonObject(row.shipping_address_json, null),
  };
}

async function replayStoredOrdersToDashboard(db, payload = {}) {
  const savedConnections = await getSavedConnections(db);
  const requestedShopId = stringOrNull(payload.shop_id || payload.shopId);
  const allRows = payload.all === true || payload.all === 'true' || payload.limit === 0 || payload.limit === '0';
  const shopId = requestedShopId || (allRows ? null : stringOrNull(savedConnections[0]?.shop_id));
  const limit = allRows ? null : Math.max(1, Math.min(5000, Number(payload.limit || 1000)));
  const batchSize = Math.max(50, Math.min(2000, Number(payload.batch_size || payload.batchSize || 500)));
  const missingOnly = payload.missing_only === true || payload.missing_only === 'true' || payload.only_missing === true || payload.only_missing === 'true';
  const tagFilter = stringOrNull(payload.tag_filter || payload.tag || payload.only_tag);
  const missingJoin = `
    LEFT JOIN integration_source_links isl
      ON isl.provider = 'pancake_pos'
     AND isl.entity_type = 'orders'
     AND isl.external_id = po.external_id
     AND isl.local_table = 'orders'
    LEFT JOIN orders o ON o.id = CAST(isl.local_id AS INTEGER)
  `;
  const missingWhere = missingOnly ? ' AND (isl.local_id IS NULL OR o.id IS NULL)' : '';
  const rows = allRows ? null : (shopId
    ? await db.prepare(`SELECT po.* FROM pos_orders po ${missingJoin} WHERE po.shop_id = ?${missingWhere} ORDER BY po.updated_at_remote DESC, po.id DESC LIMIT ?`).all(shopId, limit)
    : await db.prepare(`SELECT po.* FROM pos_orders po ${missingJoin} WHERE 1=1${missingWhere} ORDER BY po.updated_at_remote DESC, po.id DESC LIMIT ?`).all(limit));
  let scanned = 0;
  let transferred = 0;
  let skipped = 0;
  const skip_reasons = {};

  async function processRows(batch) {
    for (const row of batch) {
      scanned += 1;
      const item = storedPosOrderToPayload(row);
      if (tagFilter) {
        const tags = getPosOrderTags(item).toLowerCase();
        if (!tags.includes(tagFilter.toLowerCase())) {
          skipped += 1;
          skip_reasons.tag_filter_mismatch = (skip_reasons.tag_filter_mismatch || 0) + 1;
          continue;
        }
      }
      const skipReason = getDashboardTransferSkipReason(item);
      if (skipReason) {
        skipped += 1;
        skip_reasons[skipReason] = (skip_reasons[skipReason] || 0) + 1;
        continue;
      }
      try {
        const localId = await transferPosOrderToDashboard(db, item.shop_id || shopId, item);
        if (localId) transferred += 1;
        else {
          skipped += 1;
          skip_reasons.unknown = (skip_reasons.unknown || 0) + 1;
        }
      } catch {
        skipped += 1;
        skip_reasons.transfer_error = (skip_reasons.transfer_error || 0) + 1;
      }
    }
  }

  if (allRows) {
    let lastId = 0;
    while (true) {
      const batch = shopId
        ? await db.prepare(`SELECT po.* FROM pos_orders po ${missingJoin} WHERE po.shop_id = ? AND po.id > ?${missingWhere} ORDER BY po.id ASC LIMIT ?`).all(shopId, lastId, batchSize)
        : await db.prepare(`SELECT po.* FROM pos_orders po ${missingJoin} WHERE po.id > ?${missingWhere} ORDER BY po.id ASC LIMIT ?`).all(lastId, batchSize);
      if (!batch.length) break;
      await processRows(batch);
      lastId = Number(batch[batch.length - 1].id);
      if (batch.length < batchSize) break;
    }
  } else {
    await processRows(rows);
  }

  return {
    provider: PROVIDER,
    mode: 'pos_replay',
    shop_id: shopId,
    scanned,
    transferred,
    skipped,
    cleaned: 0,
    skip_reasons,
    tag_filter: tagFilter,
    limit: allRows ? 'all' : limit,
    batch_size: allRows ? batchSize : null,
    missing_only: missingOnly,
  };
}

async function listShopsFromApi(db, payload = {}) {
  const connections = await getSavedConnections(db);
  const firstConn = connections[0];
  const apiKey = stringOrNull(payload.api_key || firstConn?.api_key);
  const baseUrl = stringOrNull(payload.base_url || firstConn?.base_url) || POS_API_BASE;
  const response = await posRequest(baseUrl, '/shops', apiKey);
  const shops = Array.isArray(response?.shops) ? response.shops : [];
  await storeItems(db, 'shops', null, shops);
  return { shops };
}

async function resolveConnectionForValidation(db, payload = {}) {
  const connections = await getSavedConnections(db);
  const connectionId = stringOrNull(payload.connection_id || payload.id);
  const shopId = stringOrNull(payload.shop_id || payload.shopId);
  return connections.find((connection) => (
    (connectionId && connection.id === connectionId)
    || (shopId && connection.shop_id === shopId)
  )) || connections[0] || null;
}

async function validatePancakePageToken(db, payload = {}) {
  const connection = await resolveConnectionForValidation(db, payload);
  const pageId = stringOrNull(
    payload.messaging_page_id
    || payload.messagingPageId
    || payload.page_id
    || payload.pageId
    || connection?.messaging_page_id
  );
  const pageToken = stringOrNull(
    payload.page_access_token
    || payload.pageAccessToken
    || payload.pancake_token
    || payload.pancakeToken
    || connection?.page_access_token
  );

  if (!pageId) throw new Error('Missing Pancake Page ID.');
  if (!pageToken) throw new Error('Missing Pancake page access token.');

  const url = `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(pageId)}/users?page_access_token=${encodeURIComponent(pageToken)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const details = typeof data === 'string' ? truncate(data, 180) : truncate(safeJson(data), 180);
    throw new Error(`Pancake page token failed (${response.status}): ${details}`);
  }

  const users = Array.isArray(data?.users) ? data.users : [];
  const disabledUsers = Array.isArray(data?.disabled_users) ? data.disabled_users : [];
  return {
    ok: true,
    page_id: pageId,
    active_users: users.length,
    disabled_users: disabledUsers.length,
  };
}

const BOTCAKE_API_BASE = 'https://botcake.io/api/public_api/v1';
// The dashboard scopes sendable broadcast flows to a folder. Folder IDs differ
// per page, so we resolve the target folder by NAME ("UPDATE") on each page
// rather than a fixed id. Override per-request with payload.folder_id/folder_name.
const BOTCAKE_DEFAULT_FOLDER_NAME = 'UPDATE';

// Low-level Botcake call. The Public API key authenticates as a Bearer token.
// Botcake sometimes returns HTTP 200 with {"success":false}, so treat that as
// a failure too.
async function botcakeRequest(method, path, token, body) {
  const response = await fetch(`${BOTCAKE_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok || (data && typeof data === 'object' && data.success === false)) {
    const reason = stringOrNull(data?.message)
      || (typeof data === 'string' ? truncate(data, 180) : 'request rejected by Botcake');
    const err = new Error(`Botcake API failed (${response.status}): ${reason}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function botcakeFetchFlows(pageId, token) {
  const data = await botcakeRequest('GET', `/pages/${encodeURIComponent(pageId)}/flows`, token);
  const flows = Array.isArray(data?.data?.flows) ? data.data.flows
    : Array.isArray(data?.flows) ? data.flows : [];
  const folders = Array.isArray(data?.data?.folders) ? data.data.folders
    : Array.isArray(data?.folders) ? data.folders : [];
  return { flows, folders };
}

// Resolve the Botcake connection (token + Botcake page id) for a shop/connection.
async function resolveBotcakeConnection(db, payload = {}) {
  const connection = await resolveConnectionForValidation(db, payload);
  if (!connection) throw new Error('No saved POS connection found.');
  const pageId = stringOrNull(
    payload.messaging_page_id || payload.messagingPageId
    || payload.page_id || payload.pageId
    || connection.messaging_page_id
  );
  const token = stringOrNull(payload.botcake_token || payload.botcakeToken || connection.botcake_token);
  if (!pageId) throw new Error('This page has no Pancake page id saved, so Botcake cannot be reached.');
  if (!token) throw new Error('This page has no Botcake token saved.');
  return { connection, pageId, token };
}

async function validateBotcakeToken(db, payload = {}) {
  // Validate by listing the page's flows. The Public API key (Bearer) authorizes
  // this call; a valid token returns { data: { flows: [...] } }.
  // (Note: the integration_page/list_access_token endpoint always returns
  // {"success":false} for this token type, so it is NOT a usable health check.)
  const { pageId, token } = await resolveBotcakeConnection(db, payload);
  const { flows } = await botcakeFetchFlows(pageId, token);
  return { ok: true, page_id: pageId, flow_count: flows.length };
}

// List the broadcast flows available to send, scoped to one folder. Folder IDs
// differ per page, so the target folder is resolved by NAME ("UPDATE") on each
// page unless an explicit folder_id is supplied.
async function listBotcakeFlows(db, payload = {}) {
  const { connection, pageId, token } = await resolveBotcakeConnection(db, payload);
  const { flows, folders } = await botcakeFetchFlows(pageId, token);

  const explicitFolderId = stringOrNull(payload.folder_id || payload.folderId);
  const wantName = (stringOrNull(payload.folder_name) || BOTCAKE_DEFAULT_FOLDER_NAME).toLowerCase();
  const matchFolder = explicitFolderId
    ? folders.find((f) => String(f.id) === explicitFolderId)
    : folders.find((f) => (stringOrNull(f.name) || '').toLowerCase() === wantName);
  const folderId = matchFolder ? String(matchFolder.id) : (explicitFolderId || null);

  const scoped = flows
    .filter((f) => f && !f.is_removed)
    .filter((f) => folderId && String(f.parent_id ?? '') === String(folderId))
    .map((f) => ({ id: f.id, name: stringOrNull(f.name) || `Flow ${f.id}` }));

  return {
    ok: true,
    shop_id: connection.shop_id,
    page_id: pageId,
    folder_id: folderId,
    folder_name: stringOrNull(matchFolder?.name) || null,
    folder_found: Boolean(folderId),
    flows: scoped,
  };
}

// Send a Botcake flow to one or more POS-order recipients on a single page/shop.
// payload: { shop_id|connection_id, flow_id, orders:[{external_id}], psids?:[], variables? }
async function sendBotcakeFlow(db, payload = {}) {
  const { connection, pageId, token } = await resolveBotcakeConnection(db, payload);
  const flowId = stringOrNull(payload.flow_id || payload.flowId);
  if (!flowId) throw new Error('Missing flow_id (which broadcast to send).');

  const orderRefs = Array.isArray(payload.orders) ? payload.orders : [];
  const explicitPsids = Array.isArray(payload.psids)
    ? payload.psids.map(stringOrNull).filter(Boolean) : [];

  const recipients = [];
  for (const psid of explicitPsids) recipients.push({ psid, ref: psid, name: null });
  for (const ref of orderRefs) {
    const externalId = stringOrNull(ref?.external_id || ref?.externalId || ref);
    if (!externalId) continue;
    const row = await db.prepare(
      'SELECT customer_name, psid FROM pos_orders WHERE external_id = ? AND shop_id = ? LIMIT 1'
    ).get(externalId, connection.shop_id);
    recipients.push({
      psid: stringOrNull(row?.psid),
      ref: externalId,
      name: stringOrNull(row?.customer_name),
      error: row ? (row.psid ? null : 'no Messenger PSID on this order') : 'order not found on this page',
    });
  }
  if (!recipients.length) throw new Error('No recipients to send to.');

  // De-dupe by PSID so a customer with several orders is messaged once.
  const seen = new Set();
  const results = [];
  let sent = 0;
  for (const recipient of recipients) {
    if (!recipient.psid) {
      results.push({ ref: recipient.ref, name: recipient.name, ok: false, error: recipient.error || 'no PSID' });
      continue;
    }
    if (seen.has(recipient.psid)) {
      results.push({ ref: recipient.ref, name: recipient.name, ok: true, skipped: 'duplicate recipient' });
      continue;
    }
    seen.add(recipient.psid);
    try {
      const body = { psid: recipient.psid, flow_id: Number(flowId) || flowId };
      if (payload.variables && typeof payload.variables === 'object') body.payload = payload.variables;
      await botcakeRequest('POST', `/pages/${encodeURIComponent(pageId)}/flows/send_flow`, token, body);
      sent += 1;
      results.push({ ref: recipient.ref, name: recipient.name, ok: true });
    } catch (err) {
      results.push({ ref: recipient.ref, name: recipient.name, ok: false, error: err.message });
    }
  }

  return {
    ok: sent > 0,
    shop_id: connection.shop_id,
    page_id: pageId,
    flow_id: flowId,
    sent,
    failed: results.length - sent,
    results,
  };
}

// ─── POS ORDER TAGS (read + write-back to Pancake) ─────────
// Pancake POS write endpoint. posRequest is GET-only, so this handles other
// methods, mirroring its pos.pages.fm -> pos.pancake.ph 404 fallback.
async function posWrite(baseUrl, path, apiKey, method, body) {
  if (!apiKey) throw new Error('Missing Pancake POS api_key.');
  const doFetch = async (b) => {
    const url = buildUrl(b, path, { api_key: apiKey });
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { r, data, url };
  };
  const selectedBaseUrl = baseUrl || POS_API_BASE;
  let { r, data, url } = await doFetch(selectedBaseUrl);
  if (r.status === 404 && !selectedBaseUrl.includes('pos.pancake.ph')) {
    ({ r, data, url } = await doFetch('https://pos.pancake.ph/api/v1'));
  }
  if (!r.ok || (data && typeof data === 'object' && data.success === false)) {
    const reason = (data && typeof data === 'object' && stringOrNull(data.message))
      || (typeof data === 'string' ? truncate(data, 180) : 'request failed');
    throw new Error(`Pancake POS ${method} ${url.pathname} failed (${r.status}): ${reason}`);
  }
  return data;
}

// List the order tags configured for a shop (id, name, colour, group).
async function listShopOrderTags(db, payload = {}) {
  const connection = await resolveConnectionForValidation(db, payload);
  if (!connection?.api_key || !connection?.shop_id) throw new Error('No POS connection found for this shop.');
  const data = await posRequest(connection.base_url, `/shops/${connection.shop_id}/orders/tags`, connection.api_key);
  const tags = Array.isArray(data?.data) ? data.data : [];
  return {
    shop_id: connection.shop_id,
    tags: tags
      .filter((t) => t && t.id != null)
      .map((t) => ({ id: t.id, name: stringOrNull(t.name) || `Tag ${t.id}`, group: stringOrNull(t.groups?.[0]?.name) })),
  };
}

// Replace an order's tag set in Pancake, then mirror it into the local row.
// payload: { shop_id|connection_id, external_id, tags: [tagId, ...] }
async function updateOrderTags(db, payload = {}) {
  const connection = await resolveConnectionForValidation(db, payload);
  if (!connection?.api_key || !connection?.shop_id) throw new Error('No POS connection found for this shop.');
  const externalId = stringOrNull(payload.external_id || payload.externalId);
  if (!externalId) throw new Error('Missing order id.');
  if (!Array.isArray(payload.tags)) throw new Error('Missing tags.');
  const tagIds = payload.tags
    .map((t) => Number(t && typeof t === 'object' ? t.id : t))
    .filter((n) => Number.isInteger(n));

  const data = await posWrite(connection.base_url, `/shops/${connection.shop_id}/orders/${encodeURIComponent(externalId)}`, connection.api_key, 'PUT', { tags: tagIds });

  // Pancake returns the updated order; prefer its tag list (carries names).
  let newTags = Array.isArray(data?.data?.tags)
    ? data.data.tags.map((t) => ({ id: t.id, name: stringOrNull(t.name) || String(t.id) }))
    : null;
  if (!newTags) {
    const all = await listShopOrderTags(db, { shop_id: connection.shop_id });
    const byId = new Map(all.tags.map((t) => [Number(t.id), t.name]));
    newTags = tagIds.map((id) => ({ id, name: byId.get(id) || String(id) }));
  }
  await db.prepare(`UPDATE pos_orders SET tags_json = ?, updated_at = datetime('now') WHERE shop_id = ? AND external_id = ?`)
    .run(safeJson(newTags), connection.shop_id, externalId);

  return { ok: true, shop_id: connection.shop_id, external_id: externalId, tags: newTags };
}

// Delete a saved POS connection (page) from integration_settings. When
// delete_orders is set, also purge that shop's stored orders from pos_orders;
// otherwise the orders are left untouched.
async function deleteConnection(db, payload = {}) {
  const connectionId = stringOrNull(payload.connection_id || payload.connectionId || payload.id);
  if (!connectionId) throw new Error('Missing connection_id.');
  const deleteOrders = Boolean(payload.delete_orders || payload.deleteOrders);
  // Resolve the shop_id from the saved row (page_id column) so we can purge its
  // orders even if the caller didn't pass shop_id.
  const row = await db.prepare(
    `SELECT page_id AS shop_id FROM integration_settings WHERE provider = ? AND connection_id = ? LIMIT 1`
  ).get(PROVIDER, connectionId);
  const shopId = stringOrNull(payload.shop_id || payload.shopId || row?.shop_id);
  const result = await db.prepare(
    `DELETE FROM integration_settings WHERE provider = ? AND connection_id = ?`
  ).run(PROVIDER, connectionId);
  let deletedOrders = 0;
  if (deleteOrders && shopId) {
    const r2 = await db.prepare(`DELETE FROM pos_orders WHERE shop_id = ?`).run(shopId);
    deletedOrders = r2.changes || 0;
  }
  invalidateSavedConnectionsCache();
  return { ok: true, connection_id: connectionId, deleted: result.changes || 0, deleted_orders: deletedOrders, shop_id: shopId || null };
}

function collectSummaryPayload(resources, options) {
  return {
    mode: 'pos_collect',
    shop_id: options.shop_id,
    date_range: { since: options.startDateTime, until: options.endDateTime },
    resources,
  };
}

async function collectPagedItems(fetchPage, { startPage = 1, pageSize = 100, maxPages = Infinity } = {}) {
  const allItems = [];
  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const items = await fetchPage(page);
    if (!Array.isArray(items) || !items.length) break;
    allItems.push(...items);
    if (items.length < pageSize) break;
  }
  return allItems;
}

async function firstSuccessfulCollection(fetchers) {
  const errors = [];
  for (const fetcher of fetchers) {
    try {
      const items = await fetcher();
      if (Array.isArray(items)) return items;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'No API endpoints returned data.');
}

function arrayFromPancakeResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.ad_sets)) return response.ad_sets;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.results)) return response.results;
  return [];
}

function readDeepValue(source, path) {
  return String(path).split('.').reduce((node, key) => (
    node && typeof node === 'object' ? node[key] : undefined
  ), source);
}

function firstNumberFrom(source, paths = []) {
  for (const path of paths) {
    const value = readDeepValue(source, path);
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(String(value ?? '').replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeAdsBudget(item) {
  const raw = firstNumberFrom(item, ['budget', 'daily_budget', 'lifetime_budget', 'campaign_budget', 'adset_budget']);
  return raw >= 1000 ? raw / 100 : raw;
}

function normalizeCampaignId(item) {
  return stringOrNull(
    item?.campaign_id
    || item?.campaignId
    || item?.campaign?.id
    || item?.ad_campaign?.id
    || item?.adCampaign?.id
    || item?.ad_performance_session?.campaign_id
    || item?.ad_performance_session?.campaignId
  );
}

function normalizeAdSet(item, connection) {
  const insights = item?.insights && typeof item.insights === 'object' ? item.insights : {};
  const source = { ...item, insights };
  const spend = firstNumberFrom(source, ['spend', 'insights.spend']);
  const resultRoas = firstNumberFrom(source, ['result_roas', 'insights.result_roas', 'roas', 'insights.roas']);
  const campaignId = normalizeCampaignId(item);
  return {
    id: stringOrNull(item?.id || item?.adset_id || item?.ad_set_id),
    campaign_id: campaignId,
    campaign_name: stringOrNull(item?.ad_campaign?.name || item?.campaign_name || item?.campaign?.name || item?.campaignName) || 'Untitled campaign',
    name: stringOrNull(item?.name || item?.adset_name || item?.ad_set_name) || 'Untitled ad set',
    status: stringOrNull(item?.status || item?.effective_status || item?.configured_status),
    shop_id: connection.shop_id,
    shop_name: connection.name,
    budget: normalizeAdsBudget(item),
    spend,
    reach: firstNumberFrom(source, ['reach', 'insights.reach']),
    impressions: firstNumberFrom(source, ['impressions', 'insights.impressions']),
    clicks: firstNumberFrom(source, ['clicks', 'insights.clicks']),
    frequency: firstNumberFrom(source, ['frequency', 'insights.frequency']),
    cpp: firstNumberFrom(source, ['cpp', 'insights.cpp']),
    cpm: firstNumberFrom(source, ['cpm', 'insights.cpm']),
    cpc: firstNumberFrom(source, ['cpc', 'insights.cpc']),
    ctr: firstNumberFrom(source, ['ctr', 'insights.ctr']),
    cost_per_result: firstNumberFrom(source, ['cost_per_result', 'insights.cost_per_result']),
    result_roas: resultRoas,
    raw_status: stringOrNull(item?.status),
  };
}

async function listAdSetsFromApi(db, payload = {}) {
  const savedConnections = await getSavedConnections(db);
  const requestedConnectionId = stringOrNull(payload.connection_id || payload.connectionId || payload.id);
  const requestedShopId = stringOrNull(payload.shop_id || payload.shopId);
  const enabledConnections = savedConnections.filter((connection) => (
    connection.enabled !== false
    && connection.api_key
    && connection.shop_id
    && (!requestedConnectionId || connection.id === requestedConnectionId)
    && (!requestedShopId || connection.shop_id === requestedShopId)
  ));
  if (!enabledConnections.length) {
    throw new Error('No enabled Pancake POS connection with an API key and shop ID was found.');
  }

  const selectFields = stringOrNull(payload.select_fields || payload.selectFields) || [
    'ad_performance_session',
    'spend',
    'reach',
    'impressions',
    'clicks',
    'frequency',
    'cpp',
    'cpm',
    'cpc',
    'ctr',
    'cost_per_result',
    'result_roas',
  ].join(',');
  const pageSize = Math.max(1, Math.min(100, Number(payload.page_size || payload.pageSize || 50)));
  const maxPages = Math.max(1, Math.min(20, Number(payload.max_pages || payload.maxPages || 3)));

  const result = {
    provider: PROVIDER,
    resource: 'ad_sets_v2',
    select_fields: selectFields,
    shops: [],
    items: [],
    failed_shops: [],
  };

  for (const connection of enabledConnections) {
    try {
      const items = await collectPagedItems(async (page) => {
        const response = await posRequest(connection.base_url, `/shops/${connection.shop_id}/ads_manager/ad_sets_v2`, connection.api_key, {
          page,
          page_size: pageSize,
          select_fields: selectFields,
          __timeout_ms: 20000,
        });
        return arrayFromPancakeResponse(response);
      }, { startPage: Math.max(1, Number(payload.page || 1)), pageSize, maxPages });
      const normalized = items.map((item) => normalizeAdSet(item, connection));
      result.shops.push({ shop_id: connection.shop_id, name: connection.name, count: normalized.length });
      result.items.push(...normalized);
    } catch (error) {
      result.failed_shops.push({
        shop_id: connection.shop_id,
        name: connection.name,
        error: truncate(error.message, 240),
      });
    }
  }

  result.summary = {
    ad_sets: result.items.length,
    spend: result.items.reduce((sum, item) => sum + Number(item.spend || 0), 0),
    impressions: result.items.reduce((sum, item) => sum + Number(item.impressions || 0), 0),
    clicks: result.items.reduce((sum, item) => sum + Number(item.clicks || 0), 0),
    reach: result.items.reduce((sum, item) => sum + Number(item.reach || 0), 0),
    avg_roas: result.items.length
      ? result.items.reduce((sum, item) => sum + Number(item.result_roas || 0), 0) / result.items.length
      : 0,
  };
  return result;
}

async function collectPosData(db, payload = {}) {
  if (Array.isArray(payload.connections) && payload.connections.length) {
    const connections = payload.connections
      .map((connection, index) => normalizeConnection(connection, { name: `POS ${index + 1}` }))
      .filter((connection) => connection.enabled !== false && connection.api_key && connection.shop_id);
    const result = {
      provider: PROVIDER,
      mode: 'pos_collect_multi',
      connections: [],
      resources: {},
      dashboard_replay: { scanned: 0, transferred: 0, skipped: 0, skip_reasons: {} },
      failed_resources: [],
    };
    for (const connection of connections) {
      const connectionResult = await collectPosData(db, {
        ...payload,
        connections: undefined,
        api_key: connection.api_key,
        base_url: connection.base_url,
        shop_id: connection.shop_id,
        connection_name: connection.name,
        skip_save: true,
      });
      result.connections.push({
        name: connection.name,
        shop_id: connection.shop_id,
        resources: connectionResult.resources,
        failed_resources: connectionResult.failed_resources,
      });
      Object.entries(connectionResult.resources || {}).forEach(([resource, details]) => {
        result.resources[resource] = { count: (result.resources[resource]?.count || 0) + Number(details.count || 0) };
      });
      if (connectionResult.dashboard_replay) {
        result.dashboard_replay.scanned += Number(connectionResult.dashboard_replay.scanned || 0);
        result.dashboard_replay.transferred += Number(connectionResult.dashboard_replay.transferred || 0);
        result.dashboard_replay.skipped += Number(connectionResult.dashboard_replay.skipped || 0);
        Object.entries(connectionResult.dashboard_replay.skip_reasons || {}).forEach(([reason, count]) => {
          result.dashboard_replay.skip_reasons[reason] = (result.dashboard_replay.skip_reasons[reason] || 0) + Number(count || 0);
        });
      }
      result.failed_resources.push(...(connectionResult.failed_resources || []).map((failure) => ({
        ...failure,
        connection: connection.name,
      })));
    }
    result.normalized_sources = await normalizeSourceSheets(db);
    return result;
  }

  // Auto-detect: use all saved connections when no explicit api_key/shop_id given
  if (!payload.api_key && !payload.shop_id) {
    const savedConnections = await getSavedConnections(db);
    const enabledConnections = savedConnections.filter((c) => c.enabled !== false);
    if (enabledConnections.length > 0) {
      return collectPosData(db, { ...payload, connections: enabledConnections });
    }
  }

  const savedConnections = await getSavedConnections(db);
  const requestedConnectionId = stringOrNull(payload.connection_id || payload.connectionId || payload.id);
  const requestedShopId = stringOrNull(payload.shop_id || payload.shopId);
  const selectedConnection = savedConnections.find((connection) => (
    (requestedConnectionId && connection.id === requestedConnectionId)
    || (requestedShopId && connection.shop_id === requestedShopId)
  ));
  const firstConn = selectedConnection || savedConnections[0];
  const apiKey = stringOrNull(payload.api_key || firstConn?.api_key);
  const shopId = stringOrNull(payload.shop_id || firstConn?.shop_id);
  const baseUrl = stringOrNull(payload.base_url || firstConn?.base_url) || POS_API_BASE;
  if (!apiKey) throw new Error('Missing Pancake POS api_key. Save it first.');
  if (!shopId) throw new Error('Missing Pancake POS shop_id. Select a shop first.');

  const resources = Array.isArray(payload.resources) && payload.resources.length ? payload.resources : DEFAULT_RESOURCES;
  const lastSyncAt = await getLastSuccessfulSyncTime(db);
  const defaultStart = lastSyncAt ?? unixSecondsFromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const options = {
    shop_id: shopId,
    page_number: Math.max(1, Number(payload.page_number || 1)),
    page_size: Math.max(1, Math.min(100, Number(payload.page_size || 100))),
    page: Math.max(1, Number(payload.page || 1)),
    maxPages: Math.max(1, Number(payload.max_pages || payload.maxPages || 20)),
    startDateTime: Number(payload.startDateTime ?? defaultStart),
    endDateTime: Number(payload.endDateTime ?? unixSecondsFromDate(new Date(), true)),
    updatedSince: payload.updatedSince !== undefined ? Number(payload.updatedSince) : null,
  };

  const runId = await startRun(db, 'pos_collect', collectSummaryPayload(resources, options));
  const result = {
    run_id: runId,
    provider: PROVIDER,
    mode: 'pos_collect',
    shop_id: shopId,
    connection_name: stringOrNull(payload.connection_name),
    resources: {},
    sql_tables: {},
    failed_resources: [],
  };

  const fetchers = {
    shops: async () => {
      const response = await posRequest(baseUrl, '/shops', apiKey);
      return Array.isArray(response?.shops) ? response.shops : [];
    },
    warehouses: async () => {
      const response = await posRequest(baseUrl, `/shops/${shopId}/warehouses`, apiKey);
      return Array.isArray(response?.data) ? response.data : [];
    },
    orders: async () => {
      const orderExtraFields = ['return_rate', 'conversation_note'];
      // Fetch by creation date range (primary)
      const createdItems = await collectPagedItems(async (pageNumber) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/orders`, apiKey, {
          page_number: pageNumber,
          page_size: options.page_size,
          startDateTime: options.startDateTime,
          endDateTime: options.endDateTime,
          include_removed: 1,
          option_sort: 'inserted_at_desc',
          'extra_fields[]': orderExtraFields,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page_number, pageSize: options.page_size, maxPages: options.maxPages });

      // Also fetch by updated_at range to catch status changes on older orders
      const updatedSince = options.updatedSince || lastSyncAt || options.startDateTime;
      let updatedItems = [];
      try {
        updatedItems = await collectPagedItems(async (pageNumber) => {
          const response = await posRequest(baseUrl, `/shops/${shopId}/orders`, apiKey, {
            page_number: pageNumber,
            page_size: options.page_size,
            start_time_updated_at: updatedSince,
            end_time_updated_at: options.endDateTime,
            include_removed: 1,
            option_sort: 'updated_at_desc',
            'extra_fields[]': orderExtraFields,
          });
          return Array.isArray(response?.data) ? response.data : [];
        }, { startPage: 1, pageSize: options.page_size, maxPages: options.maxPages });
      } catch (err) {
        // This pass is what catches status changes (e.g. New -> Confirmed) on
        // already-created orders. If it fails, confirmations never sync — so
        // surface it instead of hiding it.
        console.warn(`[pancake_pos] updated_at order fetch failed; status changes on existing orders may be missed: ${err.message}`);
      }

      // Merge: deduplicate by external_id, prefer fresher record
      const seen = new Map();
      for (const item of [...createdItems, ...updatedItems]) {
        const id = stringOrNull(item?.id);
        if (!id) continue;
        const existing = seen.get(id);
        if (!existing || String(item?.updated_at || '') >= String(existing?.updated_at || '')) {
          seen.set(id, item);
        }
      }
      console.log(`[pancake_pos] orders fetched: created=${createdItems.length}, updated=${updatedItems.length}, merged=${seen.size} (updatedSince=${updatedSince})`);
      return [...seen.values()];
    },
    products: async () => {
      return collectPagedItems(async (pageNumber) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/products/variations`, apiKey, {
          page_number: pageNumber,
          page_size: options.page_size,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page_number, pageSize: options.page_size });
    },
    customers: async () => {
      return collectPagedItems(async (pageNumber) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/customers`, apiKey, {
          page_number: pageNumber,
          page_size: options.page_size,
          start_time_updated_at: options.startDateTime,
          end_time_updated_at: options.endDateTime,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page_number, pageSize: options.page_size });
    },
    users: async () => {
      const userMaxPages = Math.max(1, Math.min(10, Number(payload.user_max_pages || payload.userMaxPages || 5)));
      return firstSuccessfulCollection([
        async () => {
          return collectPagedItems(async (pageNumber) => {
            const response = await posRequest(baseUrl, `/shops/${shopId}/users`, apiKey, {
              page_number: pageNumber,
              page_size: options.page_size,
              __timeout_ms: 5000,
              __no_retry: true,
            });
            return Array.isArray(response?.data) ? response.data : Array.isArray(response?.users) ? response.users : [];
          }, { startPage: options.page_number, pageSize: options.page_size, maxPages: userMaxPages });
        },
        async () => {
          return collectPagedItems(async (pageNumber) => {
            const response = await posRequest(baseUrl, `/shops/${shopId}/staffs`, apiKey, {
              page_number: pageNumber,
              page_size: options.page_size,
              __timeout_ms: 5000,
              __no_retry: true,
            });
            return Array.isArray(response?.data) ? response.data : Array.isArray(response?.staffs) ? response.staffs : [];
          }, { startPage: options.page_number, pageSize: options.page_size, maxPages: userMaxPages });
        },
        async () => {
          return collectPagedItems(async (pageNumber) => {
            const response = await posRequest(baseUrl, `/shops/${shopId}/employees`, apiKey, {
              page_number: pageNumber,
              page_size: options.page_size,
              __timeout_ms: 5000,
              __no_retry: true,
            });
            return Array.isArray(response?.data) ? response.data : Array.isArray(response?.employees) ? response.employees : [];
          }, { startPage: options.page_number, pageSize: options.page_size, maxPages: userMaxPages });
        },
      ]);
    },
    transactions: async () => {
      return collectPagedItems(async (page) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/transactions`, apiKey, {
          page,
          page_size: options.page_size,
          startDateTime: options.startDateTime,
          endDateTime: options.endDateTime,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page, pageSize: options.page_size });
    },
    inventory_histories: async () => {
      return collectPagedItems(async (page) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/inventory_histories`, apiKey, {
          page,
          page_size: options.page_size,
          startDate: options.startDateTime,
          endDate: options.endDateTime,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page, pageSize: options.page_size });
    },
  };

  try {
    for (const resource of resources) {
      const fetcher = fetchers[resource];
      if (!fetcher) {
        result.failed_resources.push({ resource, error: 'Unsupported resource' });
        continue;
      }

      try {
        const items = await fetcher();
        const localIds = await storeItems(db, resource, shopId, items, result.connection_name, {
          transfer_dashboard_orders: payload.transfer_dashboard_orders === true || payload.transferDashboardOrders === true,
        });
        result.resources[resource] = { count: items.length };
        result.sql_tables[resource] = { stored: localIds.length };
      } catch (error) {
        result.failed_resources.push({ resource, error: truncate(error.message, 240) });
      }
    }

    if (resources.includes('orders') && (payload.replay_stored_orders === true || payload.replay_stored_orders === 'true')) {
      result.dashboard_replay = await replayStoredOrdersToDashboard(db, {
        shop_id: shopId,
        all: true,
        missing_only: true,
        skip_save: true,
      });
    }

    const status = result.failed_resources.length ? 'partial' : 'success';
    await finishRun(db, runId, status, {
      shop_id: shopId,
      resources: Object.fromEntries(Object.entries(result.resources).map(([key, value]) => [key, { count: value.count }])),
      sql_tables: result.sql_tables,
      dashboard_replay: result.dashboard_replay
        ? {
          scanned: result.dashboard_replay.scanned,
          transferred: result.dashboard_replay.transferred,
          skipped: result.dashboard_replay.skipped,
          skip_reasons: result.dashboard_replay.skip_reasons,
        }
        : null,
      failed_resources: result.failed_resources,
    }, null);
    return result;
  } catch (error) {
    await finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

function isWebhookOrderLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(
    value.id &&
    (
      Array.isArray(value.items) ||
      Array.isArray(value.products) ||
      Array.isArray(value.variations) ||
      Array.isArray(value.order_items) ||
      value.bill_full_name ||
      value.bill_phone_number ||
      value.shipping_address ||
      value.partner ||
      value.status_name
    )
  );
}

async function syncPancakePageUsers(db) {
  const connections = await getSavedConnections(db);
  let synced = 0;
  const errors = [];

  for (const conn of connections) {
    const pageId = stringOrNull(conn.messaging_page_id);
    const pageToken = stringOrNull(conn.page_access_token);
    if (!pageId || !pageToken) continue;

    try {
      const url = `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(pageId)}/users?page_access_token=${encodeURIComponent(pageToken)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) { errors.push({ connection: conn.name, status: response.status }); continue; }
      const data = await response.json();
      const users = [...(data.users || []), ...(data.disabled_users || [])];

      for (const user of users) {
        const userId = stringOrNull(user.id);
        if (!userId) continue;
        // Key by provider+userId only — one row per person regardless of how many pages they're on
        const externalKey = stableKey(PROVIDER, userId);
        await db.prepare(`
          INSERT INTO pos_users (external_key, shop_id, external_id, name, username, email, role_name, is_active, raw_payload, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(external_key) DO UPDATE SET
            name = excluded.name, username = excluded.username, email = excluded.email,
            role_name = excluded.role_name, is_active = excluded.is_active,
            raw_payload = excluded.raw_payload, updated_at = excluded.updated_at
        `).run(
          externalKey, conn.shop_id, userId,
          stringOrNull(user.name),
          stringOrNull(user.fb_id || user.username),
          stringOrNull(user.email),
          stringOrNull(user.status || user.role),
          user.status_in_page === 'active' ? 1 : 0,
          safeJson(user)
        );
        synced++;
      }
    } catch (err) {
      errors.push({ connection: conn.name, error: err.message });
    }
  }

  return { synced, errors };
}

function extractWebhookOrders(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.orders)) return payload.orders;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.orders)) return payload.data.orders;
  if (Array.isArray(payload?.entry)) {
    return payload.entry.flatMap((entry) => extractWebhookOrders(entry));
  }
  if (Array.isArray(payload?.changes)) {
    return payload.changes.flatMap((change) => extractWebhookOrders(change?.value || change));
  }
  if (payload?.order) return [payload.order];
  if (payload?.data?.order) return [payload.data.order];
  if (payload?.value) return extractWebhookOrders(payload.value);
  if (payload?.object && typeof payload.object === 'object') return extractWebhookOrders(payload.object);
  if (isWebhookOrderLike(payload)) return [payload];
  if (payload?.data && typeof payload.data === 'object') return [payload.data];
  return [payload].filter(value => value && typeof value === 'object');
}

// Debounce: don't trigger a hot sync more than once per 90 seconds
let _lastHotSync = 0;
const HOT_SYNC_DEBOUNCE_MS = 90 * 1000;

async function receiveWebhook(db, payload = {}) {
  const eventType = String(payload.event_type || '').toLowerCase();
  const pageId = stringOrNull(payload.page_id);

  // Pancake webhook events (messaging, post) — trigger a hot sync in background
  if (eventType === 'messaging' || eventType === 'post') {
    const now = Date.now();
    if (now - _lastHotSync < HOT_SYNC_DEBOUNCE_MS) {
      return { provider: PROVIDER, mode: 'webhook_hot_sync', triggered: false, reason: 'debounced', page_id: pageId };
    }
    _lastHotSync = now;

    // Fire-and-forget — return 200 immediately, sync in background
    const twoHoursAgo = Math.floor((now - 2 * 60 * 60 * 1000) / 1000);
    const nowSec = Math.floor(now / 1000);
    setImmediate(async () => {
      try {
        await collectPosData(db, {
          resources: ['orders'],
          startDateTime: twoHoursAgo,
          endDateTime: nowSec,
          page_size: 100,
          max_pages: 20,
          replay_stored_orders: false,
        });
      } catch { /* ignore background errors */ }
    });

    return { provider: PROVIDER, mode: 'webhook_hot_sync', triggered: true, page_id: pageId };
  }

  if (eventType === 'subscription') {
    return { provider: PROVIDER, mode: 'webhook_subscription', acknowledged: true };
  }

  // Legacy: try to extract orders directly from payload (old/custom webhook formats)
  const savedConnections = await getSavedConnections(db);
  const shopId = stringOrNull(payload.shop_id || payload.shopId || payload.shop?.id || savedConnections[0]?.shop_id);
  const orders = extractWebhookOrders(payload);
  const localIds = [];

  for (const item of orders) {
    const localId = await upsertOrder(db, shopId, item);
    if (localId) localIds.push(localId);
  }

  return {
    provider: PROVIDER,
    mode: 'webhook',
    shop_id: shopId,
    received: orders.length,
    stored: localIds.length,
  };
}

async function getStatus(db) {
  const setting = await getPublicSetting(db);
  const latestRuns = await db.prepare(`
    SELECT id, status, trigger_type, payload_summary, result_summary, error_message, started_at, finished_at
    FROM integration_sync_runs
    WHERE provider = ?
    ORDER BY started_at DESC
    LIMIT 10
  `).all(PROVIDER);

  return {
    ...setting,
    latest_runs: latestRuns.map(run => ({
      ...run,
      payload_summary: run.payload_summary ? JSON.parse(run.payload_summary) : null,
      result_summary: run.result_summary ? JSON.parse(run.result_summary) : null,
    })),
    local_counts: await getCounts(db),
  };
}

async function listPosUsers(db, payload = {}) {
  const search = stringOrNull(payload.search);
  const shopId = stringOrNull(payload.shop_id || payload.shopId);
  const page = Math.max(1, Number(payload.page || 1));
  const perPage = Math.max(1, Math.min(200, Number(payload.per_page || payload.perPage || 50)));
  const params = [];
  let where = 'WHERE 1=1';

  if (shopId && shopId !== 'all') {
    where += " AND COALESCE(shop_id, '') = ?";
    params.push(shopId);
  }

  if (search) {
    where += ` AND (
      LOWER(COALESCE(name, '')) LIKE ?
      OR LOWER(COALESCE(username, '')) LIKE ?
      OR LOWER(COALESCE(email, '')) LIKE ?
      OR LOWER(COALESCE(phone_number, '')) LIKE ?
      OR LOWER(COALESCE(role_name, '')) LIKE ?
      OR LOWER(COALESCE(shop_id, '')) LIKE ?
    )`;
    const q = `%${search.toLowerCase()}%`;
    params.push(q, q, q, q, q, q);
  }

  const total = await db.prepare(`SELECT COUNT(*) AS count FROM pos_users ${where}`).get(...params);
  const rows = await db.prepare(`
    SELECT id, external_key, shop_id, external_id, name, username, email, phone_number, role_name, is_active, updated_at
    FROM pos_users
    ${where}
    ORDER BY COALESCE(name, username, email, external_id, external_key) COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);

  return {
    data: rows.map((row) => ({ ...row, is_active: Boolean(row.is_active) })),
    total: Number(total.count || 0),
    page,
    per_page: perPage,
  };
}

// Storage retention. pos_orders is by far the largest table, so old orders are
// dropped from the local DB to keep it from refilling (they remain in Pancake and
// can be re-synced; RMO is a live dashboard for recent orders). Old sync-run logs
// are pruned too. Deletes are batched to keep locks short; we rely on autovacuum
// to reclaim the freed space and NEVER run VACUUM FULL (it can OOM / fill the disk
// on small instances). Date comparison uses a plain substr(...,1,10) text compare
// so it works identically on SQLite and Postgres without engine-specific casts.
async function pruneOldData(db, { retentionDays = 30, cutoffDate = null, batchSize = 5000 } = {}) {
  const days = Math.max(1, Number(retentionDays) || 30);
  // cutoffDate overrides the rolling-days window when a fixed date is needed.
  const cutoff = cutoffDate || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const runCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  let deletedOrders = 0;
  for (let i = 0; i < 10000; i += 1) {
    const sql = db.type === 'postgres'
      ? `DELETE FROM pos_orders WHERE ctid IN (
           SELECT ctid FROM pos_orders
           WHERE inserted_at_remote IS NOT NULL AND inserted_at_remote <> ''
             AND substr(inserted_at_remote, 1, 10) < ?
           LIMIT ?)`
      : `DELETE FROM pos_orders WHERE rowid IN (
           SELECT rowid FROM pos_orders
           WHERE inserted_at_remote IS NOT NULL AND inserted_at_remote <> ''
             AND substr(inserted_at_remote, 1, 10) < ?
           LIMIT ?)`;
    const result = await db.prepare(sql).run(cutoff, batchSize);
    const n = Number(result.changes || 0);
    deletedOrders += n;
    if (n < batchSize) break;
  }

  const runResult = await db.prepare(
    'DELETE FROM integration_sync_runs WHERE substr(CAST(started_at AS TEXT), 1, 10) < ?'
  ).run(runCutoff);

  return {
    provider: PROVIDER,
    retention_days: cutoffDate ? null : days,
    cutoff_date: cutoff,
    deleted_pos_orders: deletedOrders,
    deleted_sync_runs: Number(runResult.changes || 0),
  };
}

module.exports = {
  PROVIDER,
  POS_API_BASE,
  unixSecondsFromDate,
  pruneOldData,
  getStatus,
  getPublicSetting,
  getSavedConnections,
  saveSetting,
  listPosUsers,
  listShopsFromApi,
  listAdSetsFromApi,
  validatePancakePageToken,
  validateBotcakeToken,
  listBotcakeFlows,
  sendBotcakeFlow,
  listShopOrderTags,
  updateOrderTags,
  deleteConnection,
  collectPosData,
  replayStoredOrdersToDashboard,
  receiveWebhook,
  cleanupMalformedDashboardOrders,
  normalizeSourceSheets,
  syncPancakePageUsers,
};
