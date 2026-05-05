const crypto = require('crypto');

const PROVIDER = 'pancake';
const SUPPORTED_ENTITY_TYPES = ['orders', 'inventory', 'expenses', 'pickups', 'scans', 'customers', 'payments'];
const PANCAKE_API = {
  user: 'https://pages.fm/api/v1',
  publicV1: 'https://pages.fm/api/public_api/v1',
  publicV2: 'https://pages.fm/api/public_api/v2',
};

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function unixSecondsFromDate(value, endOfDay = false) {
  const date = value ? new Date(value) : new Date();
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return Math.floor(date.getTime() / 1000);
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrDefault(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function stableExternalKey(...parts) {
  return parts
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => String(value).trim())
    .join(':');
}

function statusFromPancake(value) {
  const raw = String(value || '').toLowerCase();
  if (['delivered', 'completed', 'success'].includes(raw)) return 'Delivered';
  if (['returned', 'return_to_sender', 'return to sender', 'failed_delivery'].includes(raw)) return 'Returned';
  if (['returning', 'rts', 'rto'].includes(raw)) return 'Returning';
  if (['shipped', 'shipping', 'packed', 'out_for_delivery', 'out for delivery'].includes(raw)) return 'Shipped';
  return 'Pending';
}

function scanTypeFromValue(value) {
  return String(value || '').toUpperCase() === 'RTS' ? 'RTS' : 'Standard';
}

function buildTrackingFallback(prefix, externalId) {
  const clean = String(externalId || Date.now()).replace(/[^A-Za-z0-9]/g, '').slice(-12);
  return `${prefix}-${clean || Date.now()}`;
}

function buildRef(prefix, externalId, fallback) {
  const normalized = stringOrNull(externalId);
  if (!normalized) return `${prefix}-${fallback}`;
  return `${prefix}-${normalized.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
}

function getSetting(db) {
  return db.prepare('SELECT * FROM integration_settings WHERE provider = ?').get(PROVIDER) || null;
}

function saveSetting(db, payload) {
  const current = getSetting(db);
  const next = {
    enabled: payload.enabled ?? current?.enabled ?? 0,
    base_url: payload.base_url ?? current?.base_url ?? null,
    api_key: payload.api_key ?? current?.api_key ?? null,
    user_access_token: payload.user_access_token ?? current?.user_access_token ?? null,
    page_id: payload.page_id ?? current?.page_id ?? null,
    page_access_token: payload.page_access_token ?? current?.page_access_token ?? null,
    webhook_secret: payload.webhook_secret ?? current?.webhook_secret ?? null,
    sync_mode: payload.sync_mode ?? current?.sync_mode ?? 'push_only',
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
      base_url: null,
      sync_mode: 'push_only',
      notes: null,
      has_api_key: false,
      page_id: null,
      has_user_access_token: false,
      has_page_access_token: false,
      has_webhook_secret: false,
    };
  }

  return {
    provider: PROVIDER,
    configured: true,
    enabled: Boolean(setting.enabled),
    base_url: setting.base_url,
    sync_mode: setting.sync_mode,
    notes: setting.notes,
    page_id: setting.page_id || null,
    has_api_key: Boolean(setting.api_key),
    has_user_access_token: Boolean(setting.user_access_token),
    has_page_access_token: Boolean(setting.page_access_token),
    has_webhook_secret: Boolean(setting.webhook_secret),
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

function upsertSourceLink(db, entityType, externalId, localTable, localId) {
  if (!externalId) return;

  db.prepare(`
    INSERT INTO integration_source_links (provider, entity_type, external_id, local_table, local_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, entity_type, external_id)
    DO UPDATE SET local_table = excluded.local_table, local_id = excluded.local_id, last_synced_at = datetime('now')
  `).run(PROVIDER, entityType, String(externalId), localTable, String(localId));
}

function findLinkedLocalId(db, entityType, externalId) {
  if (!externalId) return null;
  const link = db.prepare(`
    SELECT local_id
    FROM integration_source_links
    WHERE provider = ? AND entity_type = ? AND external_id = ?
  `).get(PROVIDER, entityType, String(externalId));

  return link?.local_id || null;
}

function getCounts(db) {
  return {
    orders: db.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
    inventory: db.prepare('SELECT COUNT(*) AS count FROM inventory').get().count,
    expenses: db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count,
    pickups: db.prepare('SELECT COUNT(*) AS count FROM daily_pickups').get().count,
    scans: db.prepare('SELECT COUNT(*) AS count FROM scan_records').get().count,
  };
}

function validateWebhookSecret(db, suppliedSecret) {
  const setting = getSetting(db);
  if (!setting?.webhook_secret) return true;
  return suppliedSecret && suppliedSecret === setting.webhook_secret;
}

function makeWebhookHash(payload, secret) {
  return crypto.createHmac('sha256', secret).update(safeJson(payload)).digest('hex');
}

function verifyWebhookSignature(db, payload, signature) {
  const setting = getSetting(db);
  if (!setting?.webhook_secret) return true;
  if (!signature) return false;
  const expected = makeWebhookHash(payload, setting.webhook_secret);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function syncOrder(db, order) {
  const externalId = stringOrNull(order.id || order.order_id || order.order_ref);
  const orderRef = stringOrNull(order.order_ref) || buildRef('ORD', externalId, Date.now());
  const trackingNo = stringOrNull(order.tracking_no || order.tracking || order.shipping_code) || buildTrackingFallback('TRK', externalId || orderRef);
  const product = stringOrNull(order.product) || stringOrNull(order.product_name) || (
    Array.isArray(order.items) && order.items.length
      ? order.items.map(item => item.name || item.product_name || item.sku || 'Item').join(', ')
      : 'Imported Product'
  );
  const customer = stringOrNull(order.customer) || stringOrNull(order.customer_name) || stringOrNull(order.buyer_name) || 'Imported Customer';
  const phone = stringOrNull(order.phone) || stringOrNull(order.customer_phone) || stringOrNull(order.receiver_phone);
  const qty = Math.max(1, Math.round(numberOrDefault(order.qty ?? order.quantity ?? order.total_quantity, 1)));
  const codAmount = numberOrDefault(order.cod_amount ?? order.cod ?? order.total_amount ?? order.total_price, 0);
  const courier = stringOrNull(order.courier) || stringOrNull(order.shipping_partner) || stringOrNull(order.shipping_provider);
  const attempts = Math.max(1, Math.round(numberOrDefault(order.attempts, 1)));
  const orderDate = stringOrNull(order.order_date) || stringOrNull(order.created_at)?.slice(0, 10) || nowDate();
  const status = statusFromPancake(order.status);

  const linkedId = findLinkedLocalId(db, 'orders', externalId);
  const existing = linkedId
    ? db.prepare('SELECT id FROM orders WHERE id = ?').get(linkedId)
    : db.prepare('SELECT id FROM orders WHERE order_ref = ? OR tracking_no = ? LIMIT 1').get(orderRef, trackingNo);

  if (existing) {
    db.prepare(`
      UPDATE orders
      SET order_ref = ?, tracking_no = ?, customer = ?, phone = ?, product = ?, qty = ?, cod_amount = ?,
          status = ?, courier = ?, attempts = ?, order_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(orderRef, trackingNo, customer, phone, product, qty, codAmount, status, courier, attempts, orderDate, existing.id);
    upsertSourceLink(db, 'orders', externalId, 'orders', existing.id);
    return { action: 'updated', localId: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO orders (order_ref, tracking_no, customer, phone, product, qty, cod_amount, status, courier, attempts, order_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(orderRef, trackingNo, customer, phone, product, qty, codAmount, status, courier, attempts, orderDate);

  upsertSourceLink(db, 'orders', externalId, 'orders', result.lastInsertRowid);
  return { action: 'created', localId: result.lastInsertRowid };
}

function syncInventoryItem(db, item) {
  const externalId = stringOrNull(item.id || item.item_id || item.product_id);
  const sku = stringOrNull(item.sku) || stringOrNull(item.code);
  const itemId = stringOrNull(item.item_id) || sku || buildRef(item.type === 'Supply' ? 'S' : 'P', externalId, Date.now()).replace('-', '');
  const name = stringOrNull(item.name) || stringOrNull(item.product_name) || 'Imported Item';
  const type = String(item.type || item.product_type || 'Product') === 'Supply' ? 'Supply' : 'Product';
  const unit = stringOrNull(item.unit) || 'pcs';
  const stock = Math.max(0, Math.round(numberOrDefault(item.stock ?? item.available_stock ?? item.quantity, 0)));
  const reorderPt = Math.max(0, Math.round(numberOrDefault(item.reorder_pt ?? item.reorder_point, type === 'Product' ? 200 : 15)));
  const costPrice = numberOrDefault(item.cost_price ?? item.cost ?? item.import_price, 0);
  const sellPrice = item.sell_price ?? item.price ?? item.sale_price ?? null;

  const linkedId = findLinkedLocalId(db, 'inventory', externalId);
  const existing = linkedId
    ? db.prepare('SELECT id, item_id, stock FROM inventory WHERE id = ?').get(linkedId)
    : db.prepare('SELECT id, item_id, stock FROM inventory WHERE sku = ? OR item_id = ? LIMIT 1').get(sku, itemId);

  if (existing) {
    db.prepare(`
      UPDATE inventory
      SET item_id = ?, name = ?, sku = ?, type = ?, unit = ?, stock = ?, reorder_pt = ?, cost_price = ?, sell_price = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(itemId, name, sku, type, unit, stock, reorderPt, costPrice, sellPrice, existing.id);

    db.prepare(`
      INSERT INTO inventory_logs (item_id, action, qty_before, qty_change, qty_after, notes, created_by)
      VALUES (?, 'adjustment', ?, ?, ?, ?, 1)
    `).run(existing.item_id, existing.stock, stock - existing.stock, stock, 'Pancake inventory sync');

    upsertSourceLink(db, 'inventory', externalId, 'inventory', existing.id);
    return { action: 'updated', localId: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO inventory (item_id, name, sku, type, unit, stock, reorder_pt, cost_price, sell_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(itemId, name, sku, type, unit, stock, reorderPt, costPrice, sellPrice);

  db.prepare(`
    INSERT INTO inventory_logs (item_id, action, qty_before, qty_change, qty_after, notes, created_by)
    VALUES (?, 'add', 0, ?, ?, ?, 1)
  `).run(itemId, stock, stock, 'Pancake inventory import');

  upsertSourceLink(db, 'inventory', externalId, 'inventory', result.lastInsertRowid);
  return { action: 'created', localId: result.lastInsertRowid };
}

function syncExpense(db, expense) {
  const externalId = stringOrNull(expense.id || expense.expense_id || expense.expense_ref);
  const expenseRef = stringOrNull(expense.expense_ref) || buildRef('EXP', externalId, Date.now());
  const expDate = stringOrNull(expense.exp_date || expense.date || expense.created_at)?.slice(0, 10) || nowDate();
  const category = ['Load', 'Utility', 'Product Supplies', 'Others'].includes(expense.category) ? expense.category : 'Others';
  const itemName = stringOrNull(expense.item_name) || stringOrNull(expense.name) || stringOrNull(expense.description) || 'Imported Expense';
  const quantity = Math.max(1, Math.round(numberOrDefault(expense.quantity ?? expense.qty, 1)));
  const unitPrice = numberOrDefault(expense.unit_price ?? expense.amount ?? expense.total, 0);
  const notedBy = stringOrNull(expense.noted_by) || stringOrNull(expense.staff_name) || 'Pancake POS';

  const linkedId = findLinkedLocalId(db, 'expenses', externalId);
  const existing = linkedId
    ? db.prepare('SELECT id FROM expenses WHERE id = ?').get(linkedId)
    : db.prepare('SELECT id FROM expenses WHERE expense_ref = ? LIMIT 1').get(expenseRef);

  if (existing) {
    db.prepare(`
      UPDATE expenses
      SET expense_ref = ?, exp_date = ?, category = ?, item_name = ?, quantity = ?, unit_price = ?, noted_by = ?
      WHERE id = ?
    `).run(expenseRef, expDate, category, itemName, quantity, unitPrice, notedBy, existing.id);
    upsertSourceLink(db, 'expenses', externalId, 'expenses', existing.id);
    return { action: 'updated', localId: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO expenses (expense_ref, exp_date, category, item_name, quantity, unit_price, noted_by, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(expenseRef, expDate, category, itemName, quantity, unitPrice, notedBy);

  upsertSourceLink(db, 'expenses', externalId, 'expenses', result.lastInsertRowid);
  return { action: 'created', localId: result.lastInsertRowid };
}

function syncPickup(db, pickup) {
  const externalId = stringOrNull(pickup.id || pickup.pickup_id || pickup.pickup_ref);
  const pickupRef = stringOrNull(pickup.pickup_ref) || buildRef('PU', externalId, Date.now());
  const pickupDate = stringOrNull(pickup.pickup_date || pickup.date || pickup.created_at)?.slice(0, 10) || nowDate();
  const productName = stringOrNull(pickup.product_name) || stringOrNull(pickup.product) || 'Imported Pickup';
  const productType = String(pickup.product_type || pickup.type || 'Product') === 'Supplies' ? 'Supplies' : 'Product';
  const customerOrders = Math.max(1, Math.round(numberOrDefault(pickup.customer_orders ?? pickup.orders_count ?? pickup.orders, 1)));
  const totalPieces = Math.max(1, Math.round(numberOrDefault(pickup.total_pieces ?? pickup.pieces ?? pickup.quantity, customerOrders)));
  const notes = stringOrNull(pickup.notes);

  const linkedId = findLinkedLocalId(db, 'pickups', externalId);
  const existing = linkedId
    ? db.prepare('SELECT id FROM daily_pickups WHERE id = ?').get(linkedId)
    : db.prepare('SELECT id FROM daily_pickups WHERE pickup_ref = ? LIMIT 1').get(pickupRef);

  if (existing) {
    db.prepare(`
      UPDATE daily_pickups
      SET pickup_ref = ?, pickup_date = ?, product_name = ?, product_type = ?, customer_orders = ?, total_pieces = ?, notes = ?
      WHERE id = ?
    `).run(pickupRef, pickupDate, productName, productType, customerOrders, totalPieces, notes, existing.id);
    upsertSourceLink(db, 'pickups', externalId, 'daily_pickups', existing.id);
    return { action: 'updated', localId: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO daily_pickups (pickup_ref, pickup_date, product_name, product_type, customer_orders, total_pieces, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(pickupRef, pickupDate, productName, productType, customerOrders, totalPieces, notes);

  upsertSourceLink(db, 'pickups', externalId, 'daily_pickups', result.lastInsertRowid);
  return { action: 'created', localId: result.lastInsertRowid };
}

function syncScan(db, scan) {
  const externalId = stringOrNull(scan.id || scan.scan_id || scan.scan_ref);
  const scanRef = stringOrNull(scan.scan_ref) || buildRef('SCN', externalId, Date.now());
  const trackingNo = stringOrNull(scan.tracking_no || scan.tracking) || buildTrackingFallback('SCAN', externalId || scanRef);
  const customer = stringOrNull(scan.customer) || stringOrNull(scan.customer_name);
  const phone = stringOrNull(scan.phone);
  const scanDate = stringOrNull(scan.scan_date || scan.date || scan.created_at)?.slice(0, 10) || nowDate();
  const status = stringOrNull(scan.status) || 'Imported';
  const courier = stringOrNull(scan.courier);
  const scanType = scanTypeFromValue(scan.scan_type || scan.type);

  const linkedId = findLinkedLocalId(db, 'scans', externalId);
  const existing = linkedId
    ? db.prepare('SELECT id FROM scan_records WHERE id = ?').get(linkedId)
    : db.prepare('SELECT id FROM scan_records WHERE scan_ref = ? OR tracking_no = ? LIMIT 1').get(scanRef, trackingNo);

  if (existing) {
    db.prepare(`
      UPDATE scan_records
      SET scan_ref = ?, tracking_no = ?, customer = ?, phone = ?, scan_date = ?, status = ?, courier = ?, scan_type = ?
      WHERE id = ?
    `).run(scanRef, trackingNo, customer, phone, scanDate, status, courier, scanType, existing.id);
    upsertSourceLink(db, 'scans', externalId, 'scan_records', existing.id);
    return { action: 'updated', localId: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO scan_records (scan_ref, tracking_no, customer, phone, scan_date, status, courier, scan_type, scanned_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(scanRef, trackingNo, customer, phone, scanDate, status, courier, scanType);

  upsertSourceLink(db, 'scans', externalId, 'scan_records', result.lastInsertRowid);
  return { action: 'created', localId: result.lastInsertRowid };
}

const processors = {
  orders: syncOrder,
  inventory: syncInventoryItem,
  expenses: syncExpense,
  pickups: syncPickup,
  scans: syncScan,
};

function summarizePayload(payload) {
  const summary = {};
  for (const entityType of SUPPORTED_ENTITY_TYPES) {
    if (Array.isArray(payload[entityType])) {
      summary[entityType] = payload[entityType].length;
    }
  }
  return summary;
}

function syncPayload(db, payload, triggerType = 'manual') {
  const runId = startRun(db, triggerType, summarizePayload(payload));
  const result = {
    run_id: runId,
    provider: PROVIDER,
    created: 0,
    updated: 0,
    stored_only: 0,
    failed: 0,
    entities: {},
    counts_before: getCounts(db),
    counts_after: null,
  };

  try {
    db.exec('BEGIN');

    for (const entityType of SUPPORTED_ENTITY_TYPES) {
      const items = Array.isArray(payload[entityType]) ? payload[entityType] : [];
      if (!items.length) continue;

      result.entities[entityType] = {
        received: items.length,
        created: 0,
        updated: 0,
        stored_only: 0,
        failed: 0,
      };

      for (const item of items) {
        const externalId = stringOrNull(item?.id || item?.external_id || item?.order_id || item?.product_id || item?.expense_id || item?.pickup_id || item?.scan_id);

        try {
          const processor = processors[entityType];
          if (!processor) {
            recordRaw(db, entityType, externalId, item, { status: 'stored' });
            result.stored_only += 1;
            result.entities[entityType].stored_only += 1;
            continue;
          }

          const syncOutcome = processor(db, item);
          recordRaw(db, entityType, externalId, item, {
            status: 'synced',
            mappedTable: entityType === 'inventory' ? 'inventory' : entityType === 'pickups' ? 'daily_pickups' : entityType === 'scans' ? 'scan_records' : entityType,
            localId: syncOutcome.localId,
          });

          if (syncOutcome.action === 'created') {
            result.created += 1;
            result.entities[entityType].created += 1;
          } else {
            result.updated += 1;
            result.entities[entityType].updated += 1;
          }
        } catch (error) {
          recordRaw(db, entityType, externalId, item, {
            status: 'error',
            errorMessage: truncate(error.message),
          });
          result.failed += 1;
          result.entities[entityType].failed += 1;
        }
      }
    }

    db.exec('COMMIT');
    result.counts_after = getCounts(db);

    const status = result.failed ? (result.created || result.updated || result.stored_only ? 'partial' : 'failed') : 'success';
    finishRun(db, runId, status, result, null);
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    finishRun(db, runId, 'failed', result, truncate(error.message));
    throw error;
  }
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, entry);
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function pancakeRequest(baseUrl, path, { method = 'GET', query, body } = {}) {
  const url = buildUrl(baseUrl, path, query);
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const details = typeof data === 'string' ? data : safeJson(data);
    throw new Error(`Pancake API ${method} ${url.pathname} failed (${response.status}): ${details}`);
  }

  return data;
}

function upsertCollectedPage(db, page) {
  const externalId = stringOrNull(page?.id);
  if (!externalId) return null;

  db.prepare(`
    INSERT INTO pancake_pages (external_id, platform, name, avatar_url, raw_payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      platform = excluded.platform,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(page.platform),
    stringOrNull(page.name),
    stringOrNull(page.avatar_url),
    safeJson(page)
  );

  return externalId;
}

function upsertCollectedConversation(db, pageId, conversation) {
  const externalId = stringOrNull(conversation?.id);
  if (!externalId) return null;

  db.prepare(`
    INSERT INTO pancake_conversations (
      external_id, page_id, conversation_type, page_uid, updated_at_remote, inserted_at_remote,
      tags_json, last_message_json, participants_json, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      page_id = excluded.page_id,
      conversation_type = excluded.conversation_type,
      page_uid = excluded.page_uid,
      updated_at_remote = excluded.updated_at_remote,
      inserted_at_remote = excluded.inserted_at_remote,
      tags_json = excluded.tags_json,
      last_message_json = excluded.last_message_json,
      participants_json = excluded.participants_json,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(pageId),
    stringOrNull(conversation.type),
    stringOrNull(conversation.page_uid),
    stringOrNull(conversation.updated_at),
    stringOrNull(conversation.inserted_at),
    safeJson(conversation.tags || []),
    safeJson(conversation.last_message || null),
    safeJson(conversation.participants || []),
    safeJson(conversation)
  );

  return externalId;
}

function upsertCollectedMessage(db, pageId, message) {
  const externalId = stringOrNull(message?.id);
  const conversationId = stringOrNull(message?.conversation_id);
  const externalKey = stableExternalKey(
    pageId,
    conversationId,
    externalId || stringOrNull(message?.inserted_at) || crypto.createHash('sha1').update(safeJson(message)).digest('hex')
  );
  if (!externalKey) return null;

  db.prepare(`
    INSERT INTO pancake_messages (
      external_key, external_id, conversation_id, page_id, sender_id, sender_name, message_text,
      message_type, has_phone, inserted_at_remote, is_hidden, is_removed, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      external_id = excluded.external_id,
      conversation_id = excluded.conversation_id,
      page_id = excluded.page_id,
      sender_id = excluded.sender_id,
      sender_name = excluded.sender_name,
      message_text = excluded.message_text,
      message_type = excluded.message_type,
      has_phone = excluded.has_phone,
      inserted_at_remote = excluded.inserted_at_remote,
      is_hidden = excluded.is_hidden,
      is_removed = excluded.is_removed,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    externalId,
    conversationId,
    stringOrNull(pageId || message.page_id),
    stringOrNull(message?.from?.id),
    stringOrNull(message?.from?.name),
    stringOrNull(message?.message || message?.original_message),
    stringOrNull(message?.type),
    boolToInt(message?.has_phone),
    stringOrNull(message?.inserted_at),
    boolToInt(message?.is_hidden),
    boolToInt(message?.is_removed),
    safeJson(message)
  );

  return externalKey;
}

function upsertCollectedCustomer(db, pageId, customer) {
  const externalId = stringOrNull(customer?.id || customer?.psid);
  const externalKey = stableExternalKey(pageId, externalId || stringOrNull(customer?.psid) || stringOrNull(customer?.name));
  if (!externalKey) return null;

  db.prepare(`
    INSERT INTO pancake_customers (
      external_key, external_id, page_id, name, gender, birthday, lives_in,
      phone_numbers_json, notes_json, inserted_at_remote, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      external_id = excluded.external_id,
      page_id = excluded.page_id,
      name = excluded.name,
      gender = excluded.gender,
      birthday = excluded.birthday,
      lives_in = excluded.lives_in,
      phone_numbers_json = excluded.phone_numbers_json,
      notes_json = excluded.notes_json,
      inserted_at_remote = excluded.inserted_at_remote,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    externalId,
    stringOrNull(pageId),
    stringOrNull(customer?.name),
    stringOrNull(customer?.gender),
    stringOrNull(customer?.birthday),
    stringOrNull(customer?.lives_in),
    safeJson(customer?.phone_numbers || []),
    safeJson(customer?.notes || []),
    stringOrNull(customer?.inserted_at),
    safeJson(customer)
  );

  return externalKey;
}

function upsertCollectedPost(db, pageId, post) {
  const externalId = stringOrNull(post?.id);
  if (!externalId) return null;

  db.prepare(`
    INSERT INTO pancake_posts (
      external_id, page_id, post_type, message, inserted_at_remote, comment_count,
      reactions_json, phone_number_count, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      page_id = excluded.page_id,
      post_type = excluded.post_type,
      message = excluded.message,
      inserted_at_remote = excluded.inserted_at_remote,
      comment_count = excluded.comment_count,
      reactions_json = excluded.reactions_json,
      phone_number_count = excluded.phone_number_count,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalId,
    stringOrNull(pageId || post.page_id),
    stringOrNull(post?.type),
    stringOrNull(post?.message),
    stringOrNull(post?.inserted_at),
    Number.isFinite(Number(post?.comment_count)) ? Number(post.comment_count) : null,
    safeJson(post?.reactions || {}),
    Number.isFinite(Number(post?.phone_number_count)) ? Number(post.phone_number_count) : null,
    safeJson(post)
  );

  return externalId;
}

function upsertCollectedTag(db, pageId, tag) {
  const externalId = stringOrNull(tag?.id);
  const externalKey = stableExternalKey(pageId, externalId || stringOrNull(tag?.text));
  if (!externalKey) return null;

  db.prepare(`
    INSERT INTO pancake_tags (external_key, external_id, page_id, text, color, lighten_color, description, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      external_id = excluded.external_id,
      page_id = excluded.page_id,
      text = excluded.text,
      color = excluded.color,
      lighten_color = excluded.lighten_color,
      description = excluded.description,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    externalId,
    stringOrNull(pageId),
    stringOrNull(tag?.text),
    stringOrNull(tag?.color),
    stringOrNull(tag?.lighten_color),
    stringOrNull(tag?.description),
    safeJson(tag)
  );

  return externalKey;
}

function upsertCollectedUser(db, pageId, user) {
  const externalId = stringOrNull(user?.id || user?.fb_id);
  const externalKey = stableExternalKey(pageId, externalId || stringOrNull(user?.name));
  if (!externalKey) return null;

  db.prepare(`
    INSERT INTO pancake_users (
      external_key, external_id, page_id, name, status, fb_id, status_in_page,
      is_online, user_group, page_permissions_json, raw_payload
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET
      external_id = excluded.external_id,
      page_id = excluded.page_id,
      name = excluded.name,
      status = excluded.status,
      fb_id = excluded.fb_id,
      status_in_page = excluded.status_in_page,
      is_online = excluded.is_online,
      user_group = excluded.user_group,
      page_permissions_json = excluded.page_permissions_json,
      raw_payload = excluded.raw_payload,
      updated_at = datetime('now')
  `).run(
    externalKey,
    externalId,
    stringOrNull(pageId),
    stringOrNull(user?.name),
    stringOrNull(user?.status),
    stringOrNull(user?.fb_id),
    stringOrNull(user?.status_in_page),
    boolToInt(user?.is_online),
    stringOrNull(user?.user_group),
    safeJson(user?.page_permissions || null),
    safeJson(user)
  );

  return externalKey;
}

function storeCollectedItems(db, resource, items, options = {}) {
  const localIds = [];
  for (const item of items) {
    let localId = null;
    if (resource === 'pages') localId = upsertCollectedPage(db, item);
    if (resource === 'conversations') localId = upsertCollectedConversation(db, options.page_id, item);
    if (resource === 'messages') localId = upsertCollectedMessage(db, options.page_id, item);
    if (resource === 'customers') localId = upsertCollectedCustomer(db, options.page_id, item);
    if (resource === 'posts') localId = upsertCollectedPost(db, options.page_id, item);
    if (resource === 'tags') localId = upsertCollectedTag(db, options.page_id, item);
    if (resource === 'users') localId = upsertCollectedUser(db, options.page_id, item);
    if (localId) localIds.push(localId);
  }
  return localIds;
}

async function listPagesFromApi(db, payload = {}) {
  const setting = getSetting(db);
  const accessToken = stringOrNull(payload.user_access_token || setting?.user_access_token || setting?.api_key);
  if (!accessToken) {
    throw new Error('Missing Pancake user access token. Save user_access_token first.');
  }

  const data = await pancakeRequest(PANCAKE_API.user, '/pages', {
    query: { access_token: accessToken },
  });

  const pages = Array.isArray(data?.pages) ? data.pages : [];
  storeCollectedItems(db, 'pages', pages);

  return {
    pages,
  };
}

async function ensurePageAccessToken(db, payload = {}) {
  const setting = getSetting(db);
  const pageId = stringOrNull(payload.page_id || setting?.page_id);
  const existingToken = stringOrNull(payload.page_access_token || setting?.page_access_token || setting?.api_key);
  if (pageId && existingToken) {
    return { page_id: pageId, page_access_token: existingToken, generated: false };
  }

  const accessToken = stringOrNull(payload.user_access_token || setting?.user_access_token || setting?.api_key);
  if (!pageId || !accessToken) {
    throw new Error('Missing page_id or user_access_token. Save both before collecting page data.');
  }

  const tokenResponse = await pancakeRequest(PANCAKE_API.user, `/pages/${pageId}/generate_page_access_token`, {
    method: 'POST',
    query: {
      page_id: pageId,
      access_token: accessToken,
    },
  });

  const pageAccessToken = stringOrNull(
    tokenResponse?.page_access_token ||
    tokenResponse?.data?.page_access_token ||
    tokenResponse?.access_token
  );

  if (!pageAccessToken) {
    throw new Error('Pancake did not return a page_access_token.');
  }

  saveSetting(db, {
    ...setting,
    user_access_token: accessToken,
    page_id: pageId,
    page_access_token: pageAccessToken,
  });

  return { page_id: pageId, page_access_token: pageAccessToken, generated: true };
}

function collectSummaryPayload(resources, options) {
  return {
    mode: 'api_collect',
    page_id: options.page_id,
    date_range: { since: options.since, until: options.until },
    resources,
  };
}

async function collectApiData(db, payload = {}) {
  const requestedResources = Array.isArray(payload.resources) && payload.resources.length
    ? payload.resources
    : ['conversations', 'customers', 'posts', 'tags', 'users', 'messages'];
  const pageToken = await ensurePageAccessToken(db, payload);
  const options = {
    page_id: pageToken.page_id,
    page_access_token: pageToken.page_access_token,
    since: numberOrDefault(payload.since, unixSecondsFromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))),
    until: numberOrDefault(payload.until, unixSecondsFromDate(new Date(), true)),
    page_size: Math.max(1, Math.min(100, Math.round(numberOrDefault(payload.page_size, 30)))),
    page_number: Math.max(1, Math.round(numberOrDefault(payload.page_number, 1))),
  };

  const runId = startRun(db, 'api_collect', collectSummaryPayload(requestedResources, options));
  const result = {
    run_id: runId,
    provider: PROVIDER,
    mode: 'api_collect',
    page_id: options.page_id,
    page_access_token: options.page_access_token,
    token_generated: pageToken.generated,
    resources: {},
    failed_resources: [],
    sql_tables: {},
  };

  const resourceFetchers = {
    conversations: async () => {
      const response = await pancakeRequest(PANCAKE_API.publicV2, `/pages/${options.page_id}/conversations`, {
        query: {
          page_access_token: options.page_access_token,
          since: options.since,
          until: options.until,
        },
      });
      return Array.isArray(response?.conversations) ? response.conversations : [];
    },
    customers: async () => {
      const response = await pancakeRequest(PANCAKE_API.publicV1, `/pages/${options.page_id}/page_customers`, {
        query: {
          page_access_token: options.page_access_token,
          since: options.since,
          until: options.until,
          page_number: options.page_number,
          page_size: options.page_size,
          order_by: payload.order_by || 'updated_at',
        },
      });
      return Array.isArray(response?.customers) ? response.customers : [];
    },
    posts: async () => {
      const response = await pancakeRequest(PANCAKE_API.publicV1, `/pages/${options.page_id}/posts`, {
        query: {
          page_access_token: options.page_access_token,
          since: options.since,
          until: options.until,
          page_number: options.page_number,
          page_size: Math.min(options.page_size, 30),
        },
      });
      return Array.isArray(response?.posts) ? response.posts : [];
    },
    tags: async () => {
      const response = await pancakeRequest(PANCAKE_API.publicV1, `/pages/${options.page_id}/tags`, {
        query: {
          page_access_token: options.page_access_token,
        },
      });
      return Array.isArray(response?.tags) ? response.tags : [];
    },
    users: async () => {
      const response = await pancakeRequest(PANCAKE_API.publicV1, `/pages/${options.page_id}/users`, {
        query: {
          page_access_token: options.page_access_token,
        },
      });
      return [
        ...(Array.isArray(response?.users) ? response.users : []),
        ...(Array.isArray(response?.disabled_users) ? response.disabled_users : []),
      ];
    },
    messages: async () => {
      const conversations = result.resources.conversations?.items || [];
      const limitedConversations = conversations.slice(0, Math.max(1, Math.min(10, Math.round(numberOrDefault(payload.message_conversation_limit, 5)))));
      const messages = [];

      for (const conversation of limitedConversations) {
        if (!conversation?.id) continue;
        const response = await pancakeRequest(PANCAKE_API.publicV1, `/pages/${options.page_id}/conversations/${conversation.id}/messages`, {
          query: {
            page_access_token: options.page_access_token,
          },
        });
        const items = Array.isArray(response?.messages) ? response.messages : [];
        for (const item of items) {
          messages.push({ conversation_id: conversation.id, ...item });
        }
      }

      return messages;
    },
  };

  try {
    for (const resource of requestedResources) {
      const fetchResource = resourceFetchers[resource];
      if (!fetchResource) {
        result.failed_resources.push({ resource, error: 'Unsupported resource' });
        continue;
      }

      try {
        const items = await fetchResource();
        const localIds = storeCollectedItems(db, resource, items, { page_id: options.page_id });
        result.resources[resource] = {
          count: items.length,
          items,
        };
        result.sql_tables[resource] = {
          stored: localIds.length,
        };
        for (const item of items) {
          const externalId = item?.id || item?.conversation_id || item?.psid || item?.fb_id;
          recordRaw(db, resource, externalId, item, {
            status: 'synced',
            mappedTable: `pancake_${resource}`,
            localId: externalId,
          });
        }
      } catch (error) {
        result.failed_resources.push({ resource, error: truncate(error.message, 240) });
      }
    }

    const status = result.failed_resources.length ? 'partial' : 'success';
    finishRun(db, runId, status, {
      page_id: result.page_id,
      token_generated: result.token_generated,
      resources: Object.fromEntries(
        Object.entries(result.resources).map(([resource, details]) => [resource, { count: details.count }])
      ),
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
  getStatus,
  getPublicSetting,
  saveSetting,
  listPagesFromApi,
  collectApiData,
  syncPayload,
  validateWebhookSecret,
  verifyWebhookSignature,
};
