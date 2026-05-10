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

function shouldStoreRawPayloads() {
  return process.env.POS_STORE_RAW_PAYLOADS === 'true';
}

function shouldStoreRawRecords() {
  return process.env.POS_STORE_RAW_RECORDS === 'true';
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

function unixSecondsFromDate(value, endOfDay = false) {
  const date = value ? new Date(value) : new Date();
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

async function getSetting(db) {
  return await db.prepare('SELECT * FROM integration_settings WHERE provider = ?').get(PROVIDER) || null;
}

async function saveSetting(db, payload) {
  const current = await getSetting(db);
  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    base_url: payload.base_url ?? current?.base_url ?? POS_API_BASE,
    api_key: payload.api_key ?? current?.api_key ?? null,
    user_access_token: payload.user_access_token ?? current?.user_access_token ?? null,
    page_id: payload.page_id ?? current?.page_id ?? null,
    page_access_token: payload.page_access_token ?? current?.page_access_token ?? null,
    webhook_secret: payload.webhook_secret ?? current?.webhook_secret ?? null,
    sync_mode: payload.sync_mode ?? current?.sync_mode ?? 'pull_only',
    notes: payload.notes ?? current?.notes ?? null,
  };

  if (current) {
    await db.prepare(`
      UPDATE integration_settings
      SET enabled = ?, base_url = ?, api_key = ?, user_access_token = ?, page_id = ?, page_access_token = ?,
          webhook_secret = ?, sync_mode = ?, notes = ?, updated_at = datetime('now')
      WHERE provider = ?
    `).run(
      boolToInt(next.enabled),
      next.base_url,
      next.api_key,
      next.user_access_token,
      next.page_id,
      next.page_access_token,
      next.webhook_secret,
      next.sync_mode,
      next.notes,
      PROVIDER
    );
  } else {
    await db.prepare(`
      INSERT INTO integration_settings (
        provider, enabled, base_url, api_key, user_access_token, page_id, page_access_token, webhook_secret, sync_mode, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      PROVIDER,
      boolToInt(next.enabled),
      next.base_url,
      next.api_key,
      next.user_access_token,
      next.page_id,
      next.page_access_token,
      next.webhook_secret,
      next.sync_mode,
      next.notes
    );
  }

  return await getPublicSetting(db);
}

async function getPublicSetting(db) {
  const setting = await getSetting(db);
  if (!setting) {
    return {
      provider: PROVIDER,
      configured: false,
      enabled: false,
      base_url: POS_API_BASE,
      sync_mode: 'pull_only',
      notes: null,
      shop_id: null,
      has_api_key: false,
    };
  }

  return {
    provider: PROVIDER,
    configured: true,
    enabled: Boolean(setting.enabled),
    base_url: setting.base_url || POS_API_BASE,
    sync_mode: setting.sync_mode,
    notes: setting.notes,
    shop_id: setting.page_id || null,
    has_api_key: Boolean(setting.api_key),
    updated_at: setting.updated_at,
  };
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

async function recordRaw(db, entityType, externalId, payload, outcome = {}) {
  if (!shouldStoreRawRecords()) return;

  await db.prepare(`
    INSERT INTO integration_raw_records (provider, entity_type, external_id, mapped_table, local_id, sync_status, error_message, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    PROVIDER,
    entityType,
    stringOrNull(externalId),
    outcome.mappedTable || null,
    outcome.localId ? String(outcome.localId) : null,
    outcome.status || 'stored',
    outcome.errorMessage || null,
    safeJson(payload)
  );
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

async function posRequest(baseUrl, path, apiKey, query = {}) {
  if (!apiKey) throw new Error('Missing Pancake POS api_key.');
  const selectedBaseUrl = baseUrl || POS_API_BASE;
  const url = buildUrl(selectedBaseUrl, path, { ...query, api_key: apiKey });
  const response = await fetch(url);
  const text = await response.text();
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
      name = excluded.name,
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

async function upsertOrder(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  await db.prepare(`
    INSERT INTO pos_orders (
      external_id, shop_id, inserted_at_remote, updated_at_remote, status, status_name, customer_name, customer_phone,
      customer_email, page_id, shipping_fee, cod, cash, total_discount, note, items_json, partner_json, shipping_address_json, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      inserted_at_remote = excluded.inserted_at_remote,
      updated_at_remote = excluded.updated_at_remote,
      status = excluded.status,
      status_name = excluded.status_name,
      customer_name = excluded.customer_name,
      customer_phone = excluded.customer_phone,
      customer_email = excluded.customer_email,
      page_id = excluded.page_id,
      shipping_fee = excluded.shipping_fee,
      cod = excluded.cod,
      cash = excluded.cash,
      total_discount = excluded.total_discount,
      note = excluded.note,
      items_json = excluded.items_json,
      partner_json = excluded.partner_json,
      shipping_address_json = excluded.shipping_address_json,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(shopId || item?.shop_id),
    stringOrNull(item?.inserted_at),
    stringOrNull(item?.updated_at),
    numberOrNull(item?.status),
    stringOrNull(item?.status_name),
    stringOrNull(item?.bill_full_name),
    stringOrNull(item?.bill_phone_number),
    stringOrNull(item?.bill_email),
    stringOrNull(item?.page_id),
    numberOrNull(item?.shipping_fee),
    numberOrNull(item?.cod),
    numberOrNull(item?.cash),
    numberOrNull(item?.total_discount),
    stringOrNull(item?.note),
    safeJson(item?.items || []),
    safeJson(item?.partner || null),
    safeJson(item?.shipping_address || null),
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

function dashboardStatusFromPos(item) {
  const value = String(item?.status_name || item?.status_text || item?.status || '').toLowerCase();
  if (value.includes('delivering') || value.includes('out for delivery')) return 'Shipped';
  if (value.includes('delivered') || value.includes('complete') || value === '4') return 'Delivered';
  if (value.includes('returning')) return 'Returning';
  if (value.includes('return') || value.includes('cancel') || value === '5') return 'Returned';
  if (value.includes('ship') || value.includes('transit') || value.includes('deliver') || value === '3') return 'Shipped';
  return 'Pending';
}

function getPosItemProductName(entry = {}) {
  const product = entry?.product || {};
  const variation = entry?.variation || {};
  return stringOrNull(
    entry?.variation_name ||
    entry?.product_name ||
    entry?.name ||
    entry?.product_display_name ||
    entry?.display_name ||
    variation?.name ||
    variation?.variation_name ||
    variation?.product_name ||
    product?.name ||
    product?.product_name
  );
}

function getPosOrderProductName(item = {}) {
  return stringOrNull(
    item?.product_name ||
    item?.product_display_name ||
    item?.variation_name ||
    (typeof item?.product === 'string' ? item.product : null) ||
    item?.product?.name ||
    item?.product?.product_name ||
    item?.variation?.name ||
    item?.variation?.variation_name
  );
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

function getPosTrackingNumber(item = {}, partner = {}, shippingAddress = {}) {
  const shipping = item?.shipping || {};
  const delivery = item?.delivery || {};
  const latestPartnerUpdate = Array.isArray(partner?.extend_update)
    ? [...partner.extend_update].reverse().find(update => stringOrNull(update?.tracking_id))
    : null;
  return stringOrNull(
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
  const items = Array.isArray(item?.items) ? item.items : [];
  if (!items.length) {
    return {
      product: getPosOrderProductName(item) || 'Pancake POS Order',
      qty: Math.max(1, Math.round(numberOrNull(item?.quantity || item?.qty) || 1)),
    };
  }

  const productNames = items
    .map(getPosItemProductName)
    .filter(Boolean);
  const qty = items.reduce((sum, entry) => sum + Math.max(0, Math.round(numberOrNull(entry?.quantity || entry?.qty) || 0)), 0);
  return {
    product: productNames.length ? productNames.slice(0, 3).join(', ') : 'Pancake POS Order',
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

async function transferPosOrderToDashboard(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;

  const summary = getOrderItemsSummary(item);
  const partner = item?.partner || {};
  const shippingAddress = item?.shipping_address || {};
  const orderRef = getPosOrderRef(item, externalId);
  const trackingNo = getPosTrackingNumber(item, partner, shippingAddress);
  if (!trackingNo) return null;

  const courier = stringOrNull(
    item?.courier ||
    item?.shipping_provider ||
    item?.partner_name ||
    partner?.name ||
    partner?.partner_name ||
    partner?.shipping_partner_name
  );
  const customer = getPosCustomerName(item, shippingAddress) || 'Pancake POS Customer';
  const phone = getPosCustomerPhone(item, shippingAddress);
  const cod = numberOrNull(item?.cod ?? item?.cash ?? item?.total_price ?? item?.total) || 0;
  const sourceName = getPosOrderSourceName(shopId, item);
  const linkedId = await findLinkedLocalId(db, 'orders', externalId);
  const existing = linkedId
    ? await db.prepare('SELECT id FROM orders WHERE id = ?').get(linkedId)
    : await db.prepare('SELECT id FROM orders WHERE order_ref = ? LIMIT 1').get(orderRef);

  if (existing) {
    await db.prepare(`
      UPDATE orders
      SET order_ref = ?, tracking_no = ?, customer = ?, phone = ?, product = ?, qty = ?, cod_amount = ?,
          status = ?, courier = ?, source_sheet = ?, order_date = ?, updated_at = datetime('now')
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
      normalizeDateString(item?.inserted_at || item?.created_at || item?.updated_at),
      existing.id
    );
    await upsertSourceLink(db, 'orders', externalId, 'orders', existing.id);
    return existing.id;
  }

  const result = await db.prepare(`
    INSERT INTO orders (order_ref, tracking_no, customer, phone, product, qty, cod_amount, status, courier, source_sheet, attempts, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    1,
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
  const result = await db.prepare(`
    DELETE FROM orders
    WHERE customer = 'Pancake POS Customer'
      AND (
        source_sheet LIKE 'Pancake POS%'
        OR source_sheet LIKE 'Shop %'
      )
  `).run();
  return result.changes || 0;
}

async function storeItems(db, resource, shopId, items) {
  const localIds = [];
  for (const item of items) {
    let localId = null;
    if (resource === 'shops') localId = await upsertShop(db, item);
    if (resource === 'warehouses') localId = await upsertWarehouse(db, shopId, item);
    if (resource === 'orders') localId = await upsertOrder(db, shopId, item);
    if (resource === 'products') localId = await upsertProduct(db, shopId, item);
    if (resource === 'customers') localId = await upsertCustomer(db, shopId, item);
    if (resource === 'users') localId = await upsertUser(db, shopId, item);
    if (resource === 'transactions') localId = await upsertTransaction(db, shopId, item);
    if (resource === 'inventory_histories') localId = await upsertInventoryHistory(db, shopId, item);
    if (resource === 'orders') await transferPosOrderToDashboard(db, shopId, item);
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

async function listShopsFromApi(db, payload = {}) {
  const setting = await getSetting(db);
  const apiKey = stringOrNull(payload.api_key || setting?.api_key);
  const baseUrl = stringOrNull(payload.base_url || setting?.base_url) || POS_API_BASE;
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

async function collectPagedItems(fetchPage, { startPage = 1, pageSize = 100, maxPages = 50 } = {}) {
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
  const setting = await getSetting(db);
  const apiKey = stringOrNull(payload.api_key || setting?.api_key);
  const shopId = stringOrNull(payload.shop_id || setting?.page_id);
  const baseUrl = stringOrNull(payload.base_url || setting?.base_url) || POS_API_BASE;
  if (!apiKey) throw new Error('Missing Pancake POS api_key. Save it first.');
  if (!shopId) throw new Error('Missing Pancake POS shop_id. Select a shop first.');

  const resources = Array.isArray(payload.resources) && payload.resources.length ? payload.resources : DEFAULT_RESOURCES;
  const options = {
    shop_id: shopId,
    page_number: Math.max(1, Number(payload.page_number || 1)),
    page_size: Math.max(1, Math.min(100, Number(payload.page_size || 30))),
    page: Math.max(1, Number(payload.page || 1)),
    startDateTime: Number(payload.startDateTime ?? unixSecondsFromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))),
    endDateTime: Number(payload.endDateTime ?? unixSecondsFromDate(new Date(), true)),
  };

  await saveSetting(db, { ...setting, api_key: apiKey, page_id: shopId, base_url: baseUrl });

  const runId = await startRun(db, 'pos_collect', collectSummaryPayload(resources, options));
  const result = {
    run_id: runId,
    provider: PROVIDER,
    mode: 'pos_collect',
    shop_id: shopId,
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
      return collectPagedItems(async (pageNumber) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/orders`, apiKey, {
          page_number: pageNumber,
          page_size: options.page_size,
          startDateTime: options.startDateTime,
          endDateTime: options.endDateTime,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page_number, pageSize: options.page_size, maxPages: Number(payload.max_pages || 200) });
    },
    products: async () => {
      return collectPagedItems(async (pageNumber) => {
        const response = await posRequest(baseUrl, `/shops/${shopId}/products/variations`, apiKey, {
          page_number: pageNumber,
          page_size: options.page_size,
        });
        return Array.isArray(response?.data) ? response.data : [];
      }, { startPage: options.page_number, pageSize: options.page_size, maxPages: Number(payload.max_pages || 200) });
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
      }, { startPage: options.page_number, pageSize: options.page_size, maxPages: Number(payload.max_pages || 200) });
    },
    users: async () => {
      return firstSuccessfulCollection([
        async () => {
          const response = await posRequest(baseUrl, `/shops/${shopId}/users`, apiKey, {
            page_number: options.page_number,
            page_size: options.page_size,
          });
          return Array.isArray(response?.data) ? response.data : Array.isArray(response?.users) ? response.users : [];
        },
        async () => {
          const response = await posRequest(baseUrl, `/shops/${shopId}/staffs`, apiKey, {
            page_number: options.page_number,
            page_size: options.page_size,
          });
          return Array.isArray(response?.data) ? response.data : Array.isArray(response?.staffs) ? response.staffs : [];
        },
        async () => {
          const response = await posRequest(baseUrl, `/shops/${shopId}/employees`, apiKey, {
            page_number: options.page_number,
            page_size: options.page_size,
          });
          return Array.isArray(response?.data) ? response.data : Array.isArray(response?.employees) ? response.employees : [];
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
      }, { startPage: options.page, pageSize: options.page_size, maxPages: Number(payload.max_pages || 200) });
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
      }, { startPage: options.page, pageSize: options.page_size, maxPages: Number(payload.max_pages || 200) });
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
        const localIds = await storeItems(db, resource, shopId, items);
        result.resources[resource] = { count: items.length, items };
        result.sql_tables[resource] = { stored: localIds.length };
        for (const item of items) {
          const externalId = item?.id || item?.user_id || item?.account_id || item?.product_id || item?.variation_id || item?.code;
          await recordRaw(db, resource, externalId, item, {
            status: 'synced',
            mappedTable: `pos_${resource}`,
            localId: externalId || localIds[0] || null,
          });
        }
      } catch (error) {
        result.failed_resources.push({ resource, error: truncate(error.message, 240) });
      }
    }

    const status = result.failed_resources.length ? 'partial' : 'success';
    await finishRun(db, runId, status, {
      shop_id: shopId,
      resources: Object.fromEntries(Object.entries(result.resources).map(([key, value]) => [key, { count: value.count }])),
      sql_tables: result.sql_tables,
      failed_resources: result.failed_resources,
    }, null);
    return result;
  } catch (error) {
    await finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

function extractWebhookOrders(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.orders)) return payload.orders;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.orders)) return payload.data.orders;
  if (payload?.order) return [payload.order];
  if (payload?.data?.order) return [payload.data.order];
  return [payload].filter(value => value && typeof value === 'object');
}

async function receiveWebhook(db, payload = {}) {
  const setting = await getSetting(db);
  const shopId = stringOrNull(payload.shop_id || payload.shopId || payload.shop?.id || setting?.page_id);
  const orders = extractWebhookOrders(payload);
  const localIds = [];

  for (const item of orders) {
    const localId = await upsertOrder(db, shopId, item);
    if (localId) localIds.push(localId);
    await transferPosOrderToDashboard(db, shopId, item);
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

  const totals = await db.prepare(`
    SELECT entity_type, COUNT(*) AS count
    FROM integration_raw_records
    WHERE provider = ?
    GROUP BY entity_type
  `).all(PROVIDER);

  return {
    ...setting,
    latest_runs: latestRuns.map(run => ({
      ...run,
      payload_summary: run.payload_summary ? JSON.parse(run.payload_summary) : null,
      result_summary: run.result_summary ? JSON.parse(run.result_summary) : null,
    })),
    raw_record_totals: totals,
    local_counts: await getCounts(db),
  };
}

module.exports = {
  PROVIDER,
  POS_API_BASE,
  getStatus,
  getPublicSetting,
  saveSetting,
  listShopsFromApi,
  collectPosData,
  receiveWebhook,
  cleanupMalformedDashboardOrders,
};
