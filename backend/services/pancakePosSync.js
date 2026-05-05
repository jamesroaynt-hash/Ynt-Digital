const PROVIDER = 'pancake_pos';
const POS_API_BASE = 'https://pos.pages.fm/api/v1';
const DEFAULT_RESOURCES = ['shops', 'warehouses', 'orders', 'products', 'customers', 'transactions', 'inventory_histories'];

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

function getSetting(db) {
  return db.prepare('SELECT * FROM integration_settings WHERE provider = ?').get(PROVIDER) || null;
}

function saveSetting(db, payload) {
  const current = getSetting(db);
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
    db.prepare(`
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
    db.prepare(`
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

  return getPublicSetting(db);
}

function getPublicSetting(db) {
  const setting = getSetting(db);
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

function startRun(db, triggerType, payloadSummary) {
  const result = db.prepare(`
    INSERT INTO integration_sync_runs (provider, direction, trigger_type, payload_summary)
    VALUES (?, 'inbound', ?, ?)
  `).run(PROVIDER, triggerType, safeJson(payloadSummary));

  return Number(result.lastInsertRowid);
}

function finishRun(db, runId, status, resultSummary, errorMessage) {
  db.prepare(`
    UPDATE integration_sync_runs
    SET status = ?, result_summary = ?, error_message = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, safeJson(resultSummary), errorMessage || null, runId);
}

function recordRaw(db, entityType, externalId, payload, outcome = {}) {
  db.prepare(`
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
  const url = buildUrl(baseUrl || POS_API_BASE, path, { ...query, api_key: apiKey });
  const response = await fetch(url);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const details = typeof data === 'string' ? data : safeJson(data);
    throw new Error(`Pancake POS API GET ${url.pathname} failed (${response.status}): ${details}`);
  }

  return data;
}

function upsertShop(db, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalId;
}

function upsertWarehouse(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalId;
}

function upsertOrder(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalId;
}

function upsertProduct(db, shopId, item) {
  const productId = stringOrNull(item?.product_id || item?.id);
  const variationId = stringOrNull(item?.variation_id || item?.id);
  const externalKey = stableKey(shopId, productId, variationId || item?.barcode || item?.custom_id || item?.name);
  if (!externalKey) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalKey;
}

function upsertCustomer(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalId;
}

function upsertTransaction(db, shopId, item) {
  const externalId = stringOrNull(item?.id);
  if (!externalId) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalId;
}

function upsertInventoryHistory(db, shopId, item) {
  const variationId = stringOrNull(item?.variation_id);
  const productId = stringOrNull(item?.product_id);
  const externalKey = stableKey(shopId, variationId, productId, item?.inserted_at, item?.action_type, item?.changed_quantity);
  if (!externalKey) return null;
  db.prepare(`
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
    safeJson(item)
  );
  return externalKey;
}

function storeItems(db, resource, shopId, items) {
  const localIds = [];
  for (const item of items) {
    let localId = null;
    if (resource === 'shops') localId = upsertShop(db, item);
    if (resource === 'warehouses') localId = upsertWarehouse(db, shopId, item);
    if (resource === 'orders') localId = upsertOrder(db, shopId, item);
    if (resource === 'products') localId = upsertProduct(db, shopId, item);
    if (resource === 'customers') localId = upsertCustomer(db, shopId, item);
    if (resource === 'transactions') localId = upsertTransaction(db, shopId, item);
    if (resource === 'inventory_histories') localId = upsertInventoryHistory(db, shopId, item);
    if (localId) localIds.push(localId);
  }
  return localIds;
}

function getCounts(db) {
  return {
    shops: db.prepare('SELECT COUNT(*) AS count FROM pos_shops').get().count,
    warehouses: db.prepare('SELECT COUNT(*) AS count FROM pos_warehouses').get().count,
    orders: db.prepare('SELECT COUNT(*) AS count FROM pos_orders').get().count,
    products: db.prepare('SELECT COUNT(*) AS count FROM pos_products').get().count,
    customers: db.prepare('SELECT COUNT(*) AS count FROM pos_customers').get().count,
    transactions: db.prepare('SELECT COUNT(*) AS count FROM pos_transactions').get().count,
    inventory_histories: db.prepare('SELECT COUNT(*) AS count FROM pos_inventory_histories').get().count,
  };
}

async function listShopsFromApi(db, payload = {}) {
  const setting = getSetting(db);
  const apiKey = stringOrNull(payload.api_key || setting?.api_key);
  const baseUrl = stringOrNull(payload.base_url || setting?.base_url) || POS_API_BASE;
  const response = await posRequest(baseUrl, '/shops', apiKey);
  const shops = Array.isArray(response?.shops) ? response.shops : [];
  storeItems(db, 'shops', null, shops);
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

async function collectPosData(db, payload = {}) {
  const setting = getSetting(db);
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
    startDateTime: Number(payload.startDateTime || unixSecondsFromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))),
    endDateTime: Number(payload.endDateTime || unixSecondsFromDate(new Date(), true)),
  };

  saveSetting(db, { ...setting, api_key: apiKey, page_id: shopId, base_url: baseUrl });

  const runId = startRun(db, 'pos_collect', collectSummaryPayload(resources, options));
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
      const response = await posRequest(baseUrl, `/shops/${shopId}/orders`, apiKey, {
        page_number: options.page_number,
        page_size: options.page_size,
        startDateTime: options.startDateTime,
        endDateTime: options.endDateTime,
      });
      return Array.isArray(response?.data) ? response.data : [];
    },
    products: async () => {
      const response = await posRequest(baseUrl, `/shops/${shopId}/products/variations`, apiKey, {
        page_number: options.page_number,
        page_size: options.page_size,
      });
      return Array.isArray(response?.data) ? response.data : [];
    },
    customers: async () => {
      const response = await posRequest(baseUrl, `/shops/${shopId}/customers`, apiKey, {
        page_number: options.page_number,
        page_size: options.page_size,
        start_time_updated_at: options.startDateTime,
        end_time_updated_at: options.endDateTime,
      });
      return Array.isArray(response?.data) ? response.data : [];
    },
    transactions: async () => {
      const response = await posRequest(baseUrl, `/shops/${shopId}/transactions`, apiKey, {
        page: options.page,
        page_size: options.page_size,
        startDateTime: options.startDateTime,
        endDateTime: options.endDateTime,
      });
      return Array.isArray(response?.data) ? response.data : [];
    },
    inventory_histories: async () => {
      const response = await posRequest(baseUrl, `/shops/${shopId}/inventory_histories`, apiKey, {
        page: options.page,
        page_size: options.page_size,
        startDate: options.startDateTime,
        endDate: options.endDateTime,
      });
      return Array.isArray(response?.data) ? response.data : [];
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
        const localIds = storeItems(db, resource, shopId, items);
        result.resources[resource] = { count: items.length, items };
        result.sql_tables[resource] = { stored: localIds.length };
        for (const item of items) {
          const externalId = item?.id || item?.product_id || item?.variation_id || item?.code;
          recordRaw(db, resource, externalId, item, {
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
    finishRun(db, runId, status, {
      shop_id: shopId,
      resources: Object.fromEntries(Object.entries(result.resources).map(([key, value]) => [key, { count: value.count }])),
      sql_tables: result.sql_tables,
      failed_resources: result.failed_resources,
    }, null);
    return result;
  } catch (error) {
    finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

function getStatus(db) {
  const setting = getPublicSetting(db);
  const latestRuns = db.prepare(`
    SELECT id, status, trigger_type, payload_summary, result_summary, error_message, started_at, finished_at
    FROM integration_sync_runs
    WHERE provider = ?
    ORDER BY started_at DESC
    LIMIT 10
  `).all(PROVIDER);

  const totals = db.prepare(`
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
    local_counts: getCounts(db),
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
};
