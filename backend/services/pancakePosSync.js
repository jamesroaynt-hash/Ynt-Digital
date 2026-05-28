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
    messaging_page_id: connection.messaging_page_id || null,
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
          (provider, connection_id, name, enabled, base_url, api_key, page_id, page_access_token, user_access_token, sync_mode, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, connection_id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          base_url = excluded.base_url,
          api_key = COALESCE(excluded.api_key, integration_settings.api_key),
          page_id = excluded.page_id,
          page_access_token = COALESCE(excluded.page_access_token, integration_settings.page_access_token),
          user_access_token = excluded.user_access_token,
          sync_mode = excluded.sync_mode,
          notes = excluded.notes,
          updated_at = datetime('now')
      `).run(
        PROVIDER, conn.id, conn.name, boolToInt(conn.enabled), conn.base_url,
        conn.api_key, conn.shop_id, conn.page_access_token, conn.messaging_page_id,
        conn.sync_mode, conn.notes
      );
    }
  }

  invalidateSavedConnectionsCache();
  return await getPublicSetting(db);
}

async function getPublicSetting(db) {
  const setting = await getSetting(db);
  const connections = await getSavedConnections(db);

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
    connections: connections.map(publicConnection),
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
  const url = new URL(path, `${baseUrl}/`);
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
  const statusNum = numberOrNull(item?.status);
  const statusName = stringOrNull(item?.status_name || item?.status_text)
    || (statusNum !== null ? (PANCAKE_STATUS_NAME[statusNum] ?? null) : null);
  if (!statusName) return null;
  const customerName = getPosCustomerName(item, item?.shipping_address || {});
  const customerPhone = getPosCustomerPhone(item, item?.shipping_address || {});
  if (!customerName && !customerPhone) return null;

  const partner = item?.partner || {};
  const shippingAddress = item?.shipping_address || {};
  const trackingNo = getPosTrackingNumber(item, partner, shippingAddress);
  const attempts = extractAttemptNumber(item, getPosOrderTags(item));
  const { name: sprinterName, tel: sprinterTel } = getPosSprintorInfo(item);

  const resolvedShopId = stringOrNull(shopId || item?.shop_id);
  const pageName = connectionName || await findSavedConnectionName(db, resolvedShopId);

  const rawItems = item?.order_details || item?.items || [];
  const noteProduct = stringOrNull(rawItems[0]?.note_product);
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
      items_json, tags_json, partner_json, shipping_address_json, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      inserted_at_remote = COALESCE(pos_orders.inserted_at_remote, excluded.inserted_at_remote),
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
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(shopId || item?.shop_id),
    normalizePosTimestamp(item?.inserted_at),
    normalizePosTimestamp(item?.updated_at),
    numberOrNull(item?.status),
    stringOrNull(item?.status_name || item?.status_text),
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
    rawPayloadForStorage(item)
  );
  return externalId;
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
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
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
    if (code === 0) return 'New';
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
  ) || `POS-${externalId}`;
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
  const summary = getOrderItemsSummary(item);
  if (!summary.product) return 'missing_product';
  return null;
}

async function transferPosOrderToDashboard(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;

  const summary = getOrderItemsSummary(item);
  const partner = item?.partner || {};
  const shippingAddress = item?.shipping_address || {};
  const orderRef = getPosOrderRef(item, externalId);
  const trackingNo = getPosTrackingNumber(item, partner, shippingAddress);

  const rawCustomer = getPosCustomerName(item, shippingAddress);
  const rawPhone = getPosCustomerPhone(item, shippingAddress);
  if (!rawCustomer && !rawPhone) return null;
  if (!summary.product) return null;

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
  const linkedId = await findLinkedLocalId(db, 'orders', externalId);
  const existing = linkedId
    ? await db.prepare('SELECT id FROM orders WHERE id = ?').get(linkedId)
    : await db.prepare('SELECT id FROM orders WHERE order_ref = ? LIMIT 1').get(orderRef);

  const attemptNum = extractAttemptNumber(item, tags);

  if (existing) {
    await db.prepare(`
      UPDATE orders
      SET order_ref = ?, tracking_no = ?, customer = ?, phone = ?, product = ?, qty = ?, cod_amount = ?,
          status = ?, courier = ?, source_sheet = ?, confirmed_by = COALESCE(?, confirmed_by), tags = ?, attempts = ?,
          order_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      orderRef,
      trackingNo,
      customer,
      phone,
      summary.product,
      summary.qty,
      cod,
      dashboardStatusFromPos(item),
      courier,
      sourceName,
      confirmedBy,
      tags,
      attemptNum,
      normalizeDateString(item?.inserted_at || item?.created_at || item?.updated_at),
      existing.id
    );
    await upsertSourceLink(db, 'orders', externalId, 'orders', existing.id);
    return existing.id;
  }

  const result = await db.prepare(`
    INSERT INTO orders (order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier, source_sheet, confirmed_by, attempts, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderRef,
    trackingNo,
    customer,
    phone,
    summary.product,
    tags,
    summary.qty,
    cod,
    dashboardStatusFromPos(item),
    courier,
    sourceName,
    confirmedBy,
    attemptNum,
    normalizeDateString(item?.inserted_at || item?.created_at || item?.updated_at)
  );
  await upsertSourceLink(db, 'orders', externalId, 'orders', result.lastInsertRowid);
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

async function cleanupMalformedDashboardOrders(db) {
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

  return cleaned;
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

async function storeItems(db, resource, shopId, items, connectionName = null) {
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
    if (resource === 'orders') await transferPosOrderToDashboard(db, shopId, item);
    if (resource === 'products') await transferPosProductToInventory(db, shopId, item);
    if (localId) localIds.push(localId);
  }
  if (resource === 'orders' && items.length > 0) {
    await cleanupMalformedDashboardOrders(db);
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

  const cleaned = await cleanupMalformedDashboardOrders(db);

  return {
    provider: PROVIDER,
    mode: 'pos_replay',
    shop_id: shopId,
    scanned,
    transferred,
    skipped,
    cleaned,
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
  const firstConn = savedConnections[0];
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
    startDateTime: Number(payload.startDateTime ?? defaultStart),
    endDateTime: Number(payload.endDateTime ?? unixSecondsFromDate(new Date(), true)),
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
      }, { startPage: options.page_number, pageSize: options.page_size });

      // Also fetch by updated_at range to catch status changes on older orders
      const updatedSince = options.updatedSince || lastSyncAt || unixSecondsFromDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
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
        }, { startPage: 1, pageSize: options.page_size });
      } catch { /* API may not support updated_at filter — ignore */ }

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
        const localIds = await storeItems(db, resource, shopId, items, result.connection_name);
        result.resources[resource] = { count: items.length, items };
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
    await transferPosOrderToDashboard(db, shopId, item);
  }

  if (orders.length > 0) {
    await cleanupMalformedDashboardOrders(db);
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

module.exports = {
  PROVIDER,
  POS_API_BASE,
  unixSecondsFromDate,
  getStatus,
  getPublicSetting,
  getSavedConnections,
  saveSetting,
  listPosUsers,
  listShopsFromApi,
  collectPosData,
  replayStoredOrdersToDashboard,
  receiveWebhook,
  cleanupMalformedDashboardOrders,
  normalizeSourceSheets,
  syncPancakePageUsers,
};
