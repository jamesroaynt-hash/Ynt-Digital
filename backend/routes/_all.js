/* ─── ORDERS ──────────────────────────────────────────────── */
const express = require('express');
const googleSheetsSync = require('../services/googleSheetsSync');
const pancakePosSync = require('../services/pancakePosSync');

function ordersRoutes(db, { dispatch } = {}) {
  const r = express.Router();
  const allowedStatuses = new Set(['New', 'Confirmed', 'Waiting for pickup', 'Shipped', 'Delivered', 'Returning', 'Returned', 'Canceled', 'Pending']);
  const allowedStatusLower = new Map([...allowedStatuses].map((s) => [s.toLowerCase(), s]));
  function normalizeStatus(raw) { return allowedStatusLower.get(String(raw || '').toLowerCase().trim()) || 'Confirmed'; }

  function parseJsonObject(value, fallback = null) {
    if (!value) return fallback;
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function stringOrNull(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  // POS timestamps are stored in UTC; the business day is Manila (UTC+8). Convert
  // before slicing the calendar date so early-morning Manila orders don't display
  // (or sort) under the previous day.
  function toManilaDate(ts) {
    if (!ts) return '';
    const raw = String(ts);
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  }

  function readNamedValue(source, keys = []) {
    if (!source || typeof source !== 'object') return null;
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
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
        if (!wanted.has(key.toLowerCase())) continue;
        if (typeof value === 'string' || typeof value === 'number') return stringOrNull(value);
        const name = stringOrNull(value?.name || value?.full_name || value?.username || value?.label || value?.title);
        if (name) return name;
      }

      for (const value of Object.values(node)) {
        const match = visit(value);
        if (match) return match;
      }
      return null;
    }

    return visit(source);
  }

  function enrichOrderReportMeta(rows = []) {
    return rows.map((row) => {
      const shipping = parseJsonObject(row.pos_shipping_address_json, {});
      const raw = parseJsonObject(row.pos_raw_payload, {});
      const city = readNamedValue(shipping, ['city', 'city_name', 'municipality', 'town'])
        || readNamedValue(raw?.shipping_address, ['city', 'city_name', 'municipality', 'town']);
      const province = readNamedValue(shipping, ['province', 'province_name', 'state', 'region'])
        || readNamedValue(raw?.shipping_address, ['province', 'province_name', 'state', 'region']);
      const confirmedBy = stringOrNull(row.confirmed_by) || readNamedValue(raw, [
        'confirmed_by',
        'confirmed_by_name',
        'confirmer',
        'confirmer_name',
        'confirmed_user',
        'seller',
        'seller_name',
        'employee',
        'employee_name',
        'staff',
        'staff_name',
        'created_by',
        'creator',
        'marketer',
        'assignee',
      ]);
      const { pos_shipping_address_json, pos_raw_payload, ...cleanRow } = row;
      return { ...cleanRow, city, province, confirmed_by: confirmedBy };
    });
  }

  function getPageName(page) {
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

  function getPageId(page) {
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
    if (!target || !payload || typeof payload !== 'object') return null;
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

      if (getPageId(node) === target) {
        const name = getPageName(node);
        if (name) return name;
      }

      for (const value of Object.values(node)) {
        const match = visit(value);
        if (match) return match;
      }
      return null;
    }

    return visit(payload);
  }

  async function resolvePancakeSourceName(order) {
    const rawSource = stringOrNull(order?.source_sheet);
    const shopMatch = rawSource?.match(/^Shop\s+(.+)$/i);
    if (!shopMatch) return rawSource;

    const link = await db.prepare(`
      SELECT external_id
      FROM integration_source_links
      WHERE provider = 'pancake_pos'
        AND entity_type = 'orders'
        AND local_table = 'orders'
        AND local_id = ?
      LIMIT 1
    `).get(String(order.id));
    const posOrder = link?.external_id
      ? await db.prepare('SELECT shop_id, page_id, raw_payload FROM pos_orders WHERE external_id = ? LIMIT 1').get(link.external_id)
      : null;
    const rawPayload = parseJsonObject(posOrder?.raw_payload, {});
    const shopId = stringOrNull(posOrder?.shop_id || rawPayload?.shop_id || shopMatch[1]);
    const pageId = stringOrNull(
      posOrder?.page_id ||
      rawPayload?.page_id ||
      rawPayload?.fanpage_id ||
      rawPayload?.facebook_page_id ||
      rawPayload?.fb_page_id
    );
    const shop = shopId
      ? await db.prepare('SELECT name, pages_json, raw_payload FROM pos_shops WHERE external_id = ? LIMIT 1').get(shopId)
      : null;
    const pages = parseJsonObject(shop?.pages_json, []);
    const shopPayload = parseJsonObject(shop?.raw_payload, {});
    const setting = await db.prepare(`
      SELECT user_access_token
      FROM integration_settings
      WHERE provider = 'pancake_pos'
      LIMIT 1
    `).get();
    const savedConnections = parseJsonObject(setting?.user_access_token, []);
    const connection = Array.isArray(savedConnections)
      ? savedConnections.find((item) => stringOrNull(item?.shop_id || item?.shopId || item?.page_id) === shopId)
      : null;
    return findPageNameById({ pages }, pageId)
      || findPageNameById(shopPayload, pageId)
      || getPageName(rawPayload?.page || rawPayload?.fanpage || rawPayload?.facebook_page || rawPayload?.fb_page)
      || stringOrNull(shop?.name)
      || stringOrNull(connection?.name || connection?.label)
      || rawSource;
  }

  async function normalizeOrderPageNames(rows = []) {
    // Only resolve rows that need it (source_sheet starts with "Shop ")
    const shopRows = rows.filter((row) => /^Shop\s+/i.test(row.source_sheet || ''));
    if (!shopRows.length) return rows;

    // Batch: resolve all shop source names in parallel
    const resolved = new Map();
    await Promise.all(shopRows.map(async (row) => {
      const name = await resolvePancakeSourceName(row);
      if (name && name !== row.source_sheet) resolved.set(row.id, name);
    }));

    if (!resolved.size) return rows;
    return rows.map((row) => resolved.has(row.id) ? { ...row, source_sheet: resolved.get(row.id) } : row);
  }

  function cleanOrder(row = {}, index = 0) {
    return {
      order_ref: String(row.order_ref || row.id || `IMP-${Date.now()}-${index + 1}`).trim(),
      tracking_no: String(row.tracking_no || row.tracking || '').trim() || null,
      customer: String(row.customer || row.customer_name || row.name || '').trim(),
      phone: String(row.phone || row.phone_number || row.mobile || '').trim() || null,
      product: String(row.product || row.product_name || row.item || '').trim(),
      tags: String(row.tags || row.tag || row.labels || '').trim() || null,
      qty: Number.parseInt(row.qty || row.quantity || 1, 10) || 1,
      cod_amount: Number.parseFloat(row.cod_amount || row.cod || row.amount || row.price || 0) || 0,
      status: normalizeStatus(row.status),
      courier: String(row.courier || row.shipper || '').trim() || null,
      source_sheet: String(row.source_sheet || row.source || 'CSV Import').trim() || 'CSV Import',
      order_date: String(row.order_date || row.date || row.created_at || '').slice(0, 10) || new Date().toISOString().split('T')[0],
    };
  }

  async function upsertOrder(row) {
    await db.prepare(`
      INSERT INTO orders (
        order_ref, tracking_no, customer, phone, product, tags, qty, cod_amount, status, courier, source_sheet, order_date, created_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(order_ref) DO UPDATE SET
        tracking_no = excluded.tracking_no,
        customer = excluded.customer,
        phone = excluded.phone,
        product = excluded.product,
        tags = excluded.tags,
        qty = excluded.qty,
        cod_amount = excluded.cod_amount,
        status = excluded.status,
        courier = excluded.courier,
        source_sheet = excluded.source_sheet,
        order_date = excluded.order_date,
        updated_at = datetime('now')
    `).run(
      row.order_ref,
      row.tracking_no,
      row.customer,
      row.phone,
      row.product,
      row.tags,
      row.qty,
      row.cod_amount,
      row.status,
      row.courier,
      row.source_sheet,
      row.order_date
    );
  }

  // ── pos_orders is now the dashboard source of truth (Pancake POS only, 2026+).
  // The orders-table copy is retired; these helpers project pos_orders rows into
  // the same shape the frontend's mapBackendOrder() already consumes.
  const POS_STATUS_DISPLAY = {
    new: 'New',
    submitted: 'Confirmed',
    pending: 'Waiting for pickup', wait_print: 'Waiting for pickup', waitting: 'Waiting for pickup',
    shipped: 'Shipped', delivered: 'Delivered',
    returning: 'Returning', returned: 'Returned',
  };
  function posDisplayStatus(statusName) {
    if (!statusName) return 'New';
    return POS_STATUS_DISPLAY[statusName]
      || (statusName.charAt(0).toUpperCase() + statusName.slice(1));
  }
  // SQL CASE producing the same display status, for GROUP BY aggregation.
  const POS_STATUS_CASE = `CASE
    WHEN status_name = 'new' THEN 'New'
    WHEN status_name = 'submitted' THEN 'Confirmed'
    WHEN status_name IN ('pending','wait_print','waitting') THEN 'Waiting for pickup'
    WHEN status_name = 'shipped'   THEN 'Shipped'
    WHEN status_name = 'delivered' THEN 'Delivered'
    WHEN status_name = 'returning' THEN 'Returning'
    WHEN status_name = 'returned'  THEN 'Returned'
    ELSE 'Confirmed'
  END`;

  function posRowToOrderShape(row) {
    const shipping = parseJsonObject(row.shipping_address_json, {});
    const province = readNamedValue(shipping, ['province', 'province_name', 'state', 'region']);
    const city = readNamedValue(shipping, ['city', 'city_name', 'district']);
    const partner = parseJsonObject(row.partner_json, {});
    const courier = (partner && (partner.partner_name || partner.name)) || row.sprinter_name || '';
    const items = parseJsonObject(row.items_json, []);
    let qty = Array.isArray(items)
      ? items.reduce((s, it) => s + Number(it?.quantity || it?.qty || 0), 0)
      : 0;
    if (!qty) qty = 1;
    const tagList = parseJsonObject(row.tags_json, []).map((t) =>
      typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || '')).filter(Boolean);
    return {
      id: row.external_id,
      order_ref: row.external_id,
      dbId: row.external_id,
      tracking_no: row.tracking_no || '',
      customer: row.customer_name || '',
      phone: row.customer_phone || '',
      product: row.note_product || '',
      qty,
      cod_amount: Number(row.cod || 0),
      status: posDisplayStatus(row.status_name),
      courier,
      source_sheet: row.page_name || 'POS',
      confirmed_by: row.assigning_seller_name || '',
      attempts: Number(row.attempts || 1),
      order_date: toManilaDate(row.inserted_at_effective || row.inserted_at_remote),
      tags: tagList.join(', '),
      pos_tags_json: row.tags_json,
      city: city || '',
      province: province || '',
      shop_id: row.shop_id,
      updated_at: row.updated_at || '',
    };
  }

  // Manila-day expression (UTC+8) reused by every dashboard read, mirroring /pos-orders.
  function posManilaExprs() {
    const effectiveInsertedAt = db.type === 'postgres'
      ? "COALESCE(NULLIF(raw_payload::jsonb ->> 'inserted_at', ''), inserted_at_remote)"
      : "COALESCE(NULLIF(json_extract(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END, '$.inserted_at'), ''), inserted_at_remote)";
    const manilaDay = db.type === 'postgres'
      ? `to_char((${effectiveInsertedAt})::timestamp + interval '8 hours', 'YYYY-MM-DD')`
      : `date(${effectiveInsertedAt}, '+8 hours')`;
    return { effectiveInsertedAt, manilaDay };
  }

  // Single filter builder for all pos_orders-backed dashboard reads.
  function posDashboardWhere(q = {}) {
    const { manilaDay } = posManilaExprs();
    const params = [];
    let where = "WHERE customer_phone IS NOT NULL AND customer_phone != ''";
    where += ` AND ${manilaDay} >= '2026-01-01'`; // dashboard is 2026+ only
    where += ` AND status_name NOT IN ('canceled','removed')`; // canceled excluded from all views

    const statusVal = q.status;
    if (statusVal && statusVal !== 'All' && statusVal !== 'all') {
      const map = { New: ['new'], Confirmed: ['submitted'], 'Waiting for pickup': ['pending', 'wait_print', 'waitting'], Shipped: ['shipped'], Delivered: ['delivered'], Returning: ['returning'], Returned: ['returned'] };
      const raws = map[statusVal];
      if (raws) { where += ` AND status_name IN (${raws.map(() => '?').join(',')})`; params.push(...raws); }
    }
    const sourceVal = q.source_sheet || q.source;
    if (sourceVal && sourceVal !== 'all') { where += ` AND page_name = ?`; params.push(String(sourceVal)); }
    if (q.product && q.product !== 'all') { where += ` AND LOWER(COALESCE(note_product,'')) LIKE ?`; params.push(`%${String(q.product).toLowerCase()}%`); }
    const tagVal = q.pos_tag || q.tags;
    if (tagVal && tagVal !== 'all') { where += ` AND LOWER(COALESCE(tags_json,'')) LIKE ?`; params.push(`%${String(tagVal).toLowerCase()}%`); }

    if (q.month && q.month !== 'all') {
      const y = q.year && q.year !== 'all' ? Number(q.year) : new Date().getUTCFullYear();
      const m = Math.max(1, Math.min(12, Number(q.month)));
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      where += ` AND ${manilaDay} >= ? AND ${manilaDay} < ?`; params.push(start, end);
    } else if (q.year && q.year !== 'all') {
      where += ` AND ${manilaDay} >= ? AND ${manilaDay} < ?`; params.push(`${q.year}-01-01`, `${Number(q.year) + 1}-01-01`);
    }

    // Manila "now" computed in JS so date filters are DB-portable.
    const manilaNow = new Date(Date.now() + 8 * 3600 * 1000);
    const ymd = (d) => d.toISOString().slice(0, 10);
    if (q.date_filter === 'today') { where += ` AND ${manilaDay} = ?`; params.push(ymd(manilaNow)); }
    else if (q.date_filter === 'yesterday') { const y = new Date(manilaNow); y.setUTCDate(y.getUTCDate() - 1); where += ` AND ${manilaDay} = ?`; params.push(ymd(y)); }
    else if (q.date_filter === 'month') { where += ` AND ${manilaDay} >= ?`; params.push(`${ymd(manilaNow).slice(0, 7)}-01`); }
    else if (q.date_filter === 'year') { where += ` AND ${manilaDay} >= ?`; params.push(`${ymd(manilaNow).slice(0, 4)}-01-01`); }
    else if (q.date_filter === 'custom') {
      if (q.date_from) { where += ` AND ${manilaDay} >= ?`; params.push(String(q.date_from).slice(0, 10)); }
      if (q.date_to) { where += ` AND ${manilaDay} <= ?`; params.push(String(q.date_to).slice(0, 10)); }
    }
    if (q.filter === 'weekly') { const w = new Date(manilaNow); w.setUTCDate(w.getUTCDate() - 7); where += ` AND ${manilaDay} >= ?`; params.push(ymd(w)); }
    if (q.filter === 'monthly') { where += ` AND ${manilaDay} >= ?`; params.push(`${ymd(manilaNow).slice(0, 7)}-01`); }
    if (q.filter === 'yearly') { where += ` AND ${manilaDay} >= ?`; params.push(`${ymd(manilaNow).slice(0, 4)}-01-01`); }

    if (q.search) {
      where += ` AND (LOWER(COALESCE(external_id,'')) LIKE ? OR LOWER(COALESCE(customer_name,'')) LIKE ? OR LOWER(COALESCE(customer_phone,'')) LIKE ? OR LOWER(COALESCE(tracking_no,'')) LIKE ? OR LOWER(COALESCE(note_product,'')) LIKE ? OR LOWER(COALESCE(page_name,'')) LIKE ? OR LOWER(COALESCE(assigning_seller_name,'')) LIKE ?)`;
      const s = `%${String(q.search).toLowerCase()}%`; params.push(s, s, s, s, s, s, s);
    }
    return { where, params };
  }

  r.get('/', async (req, res) => {
    const perPage = Math.max(1, Math.min(10000, parseInt(req.query.per_page) || 10));
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (pageNum - 1) * perPage;
    const { effectiveInsertedAt } = posManilaExprs();
    const { where, params } = posDashboardWhere(req.query);

    // Incremental delta: ?since=<updated_at> returns only rows changed at/after
    // that watermark so the client can upsert instead of re-pulling the whole
    // list (~2.3MB raw). `total` is always the full filtered count so the client
    // can detect deletions (count shrank) and resync with a full reload.
    let deltaWhere = where;
    const deltaParams = [...params];
    if (req.query.since) {
      deltaWhere += ` AND updated_at >= ?`;
      deltaParams.push(String(req.query.since));
    }

    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM pos_orders ${where}`).get(...params)).c;
    const rows = await db.prepare(`
      SELECT external_id, shop_id, tracking_no, page_name,
             inserted_at_remote, ${effectiveInsertedAt} AS inserted_at_effective,
             customer_name, customer_phone, note_product, items_json, tags_json,
             attempts, cod, assigning_seller_name, status_name,
             sprinter_name, partner_json, shipping_address_json, updated_at
      FROM pos_orders ${deltaWhere}
      ORDER BY ${effectiveInsertedAt} DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...deltaParams, perPage, offset);

    res.json({
      data: rows.map(posRowToOrderShape),
      total,
      page: pageNum,
      per_page: perPage,
    });
  });

  r.get('/stats', async (req, res) => {
    const { where, params } = posDashboardWhere({});
    const counts = await db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(cod), 0) AS total_cod
      FROM (SELECT ${POS_STATUS_CASE} AS status, cod FROM pos_orders ${where}) t
      GROUP BY status
    `).all(...params);
    const total_orders = counts.reduce((s, r) => s + Number(r.count || 0), 0);
    const total_cod = counts.reduce((s, r) => s + Number(r.total_cod || 0), 0);
    res.json({ status_counts: counts, total_orders, total_cod });
  });

  r.get('/summary', async (req, res) => {
    const { where, params } = posDashboardWhere(req.query);
    const rows = await db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(cod), 0) AS total_cod
      FROM (SELECT ${POS_STATUS_CASE} AS status, cod FROM pos_orders ${where}) t
      GROUP BY status
      ORDER BY count DESC
    `).all(...params);
    const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
    const total_cod = rows.reduce((sum, row) => sum + Number(row.total_cod || 0), 0);
    res.json({ total, total_cod, status_counts: rows });
  });

  async function getPosOrdersVersion() {
    const row = await db.prepare(`
      SELECT MAX(updated_at) AS max_updated, COUNT(*) AS total
      FROM pos_orders
      WHERE customer_phone IS NOT NULL AND customer_phone != ''
    `).get();
    return `${row?.max_updated || ''}:${row?.total || 0}`;
  }

  r.get('/pos-orders/version', async (req, res) => {
    res.json({ version: await getPosOrdersVersion() });
  });

  // Lightweight lookup by external_id list — used by CSR records live status.
  r.get('/pos-orders/by-ids', async (req, res) => {
    const raw = String(req.query.ids || '');
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
    if (!ids.length) return res.json({ data: [] });
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT external_id, status_name, tracking_no FROM pos_orders WHERE external_id IN (${placeholders})`
    ).all(...ids);
    res.json({
      data: rows.map((row) => ({
        id: row.external_id,
        status: posDisplayStatus(row.status_name),
        tracking: row.tracking_no || '',
      })),
    });
  });

  r.get('/pos-orders/dashboard', async (req, res) => {
    const rows = await db.prepare(`
      SELECT external_id, tracking_no, page_name, inserted_at_remote,
             customer_name, customer_phone, note_product, tags_json,
             cod, assigning_seller_name, status_name, attempts,
             shipping_address_json
      FROM pos_orders
      WHERE customer_phone IS NOT NULL AND customer_phone != ''
      ORDER BY inserted_at_remote DESC
      LIMIT 200
    `).all();

    const statusMap = {
      new: 'New',
      submitted: 'Confirmed',
      pending: 'Waiting for pickup', wait_print: 'Waiting for pickup', waitting: 'Waiting for pickup',
      shipped: 'Shipped', delivered: 'Delivered',
      returning: 'Returning', returned: 'Returned',
      canceled: 'Canceled', removed: 'Canceled',
    };

    res.json({
      version: await getPosOrdersVersion(),
      data: rows.map((row) => {
        const shipping = parseJsonObject(row.shipping_address_json, {});
        const province = readNamedValue(shipping, ['province', 'province_name', 'state', 'region', 'city', 'city_name']);
        return {
          id: row.external_id,
          tracking: row.tracking_no,
          sourceSheet: row.page_name || 'POS',
          date: toManilaDate(row.inserted_at_remote),
          customer: row.customer_name,
          phone: row.customer_phone,
          product: row.note_product,
          tags: parseJsonObject(row.tags_json, []).map((t) =>
            typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || '')
          ).filter(Boolean),
          cod: Number(row.cod || 0),
          assigning_seller_name: row.assigning_seller_name,
          attempts: row.attempts,
          status: statusMap[row.status_name] || (row.status_name
            ? row.status_name.charAt(0).toUpperCase() + row.status_name.slice(1)
            : 'New'),
          status_name: row.status_name,
          province: province || null,
        };
      }),
    });
  });

  // Full report dataset sourced from pos_orders (the single source of truth for
  // ROAS Summary, RTS Rate, Marketing Center, CSR and Home). Paged so the client
  // can load every order; shaped to match what the dashboards expect.
  r.get('/pos-orders/report', async (req, res) => {
    const perPage = Math.max(1, Math.min(5000, Number(req.query.per_page) || 1000));
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const offset = (pageNum - 1) * perPage;

    const totalRow = await db.prepare(
      `SELECT COUNT(*) AS c FROM pos_orders WHERE customer_phone IS NOT NULL AND customer_phone != ''`
    ).get();
    const total = Number(totalRow?.c || 0);

    const rows = await db.prepare(`
      SELECT external_id, tracking_no, page_name, inserted_at_remote,
             customer_name, customer_phone, note_product, tags_json,
             cod, assigning_seller_name, status_name, attempts, shipping_address_json
      FROM pos_orders
      WHERE customer_phone IS NOT NULL AND customer_phone != ''
      ORDER BY inserted_at_remote DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(perPage, offset);

    const statusMap = {
      new: 'New',
      submitted: 'Confirmed',
      pending: 'Waiting for pickup', wait_print: 'Waiting for pickup', waitting: 'Waiting for pickup',
      shipped: 'Shipped', delivered: 'Delivered',
      returning: 'Returning', returned: 'Returned',
      canceled: 'Canceled', removed: 'Canceled',
    };

    res.json({
      version: await getPosOrdersVersion(),
      page: pageNum,
      per_page: perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
      records: rows.map((row) => {
        const shipping = parseJsonObject(row.shipping_address_json, {});
        const province = readNamedValue(shipping, ['province', 'province_name', 'state', 'region', 'city', 'city_name']);
        const tags = parseJsonObject(row.tags_json, []).map((t) =>
          typeof t === 'string' ? t : (t?.name || t?.tag_name || t?.label || '')
        ).filter(Boolean);
        const status = statusMap[row.status_name] || (row.status_name
          ? row.status_name.charAt(0).toUpperCase() + row.status_name.slice(1)
          : 'New');
        return {
          id: row.external_id,
          tracking: row.tracking_no || '',
          customer: row.customer_name || '',
          phone: row.customer_phone || '',
          product: row.note_product || '',
          attempts: Number(row.attempts || 0),
          status,
          status_name: row.status_name,
          cod: Number(row.cod || 0),
          province: province || '',
          assigning_seller_name: row.assigning_seller_name || '',
          confirmed_by: row.assigning_seller_name || '',
          tags: tags.join(', '),
          date: toManilaDate(row.inserted_at_remote) || '',
          source_sheet: row.page_name || 'POS',
          sourceSheet: row.page_name || 'POS',
        };
      }),
    });
  });

  r.get('/pos-orders', async (req, res) => {
    const {
      page = 1, per_page = 50,
      search, product, source: pageFilter, status, tags, attempts,
      period, date_from, date_to,
    } = req.query;
    const perPage = Math.max(1, Math.min(100, Number(per_page) || 50));
    const pageNum = Math.max(1, Number(page) || 1);
    const offset = (pageNum - 1) * perPage;
    const params = [];

    let where = "WHERE customer_phone IS NOT NULL AND customer_phone != ''";

    if (search) {
      // Allow searching several order #s / tracking codes / phones at once by
      // separating them with spaces — each term is matched (OR) so a paste of
      // multiple tracking numbers returns all of them.
      const terms = String(search).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 50);
      if (terms.length) {
        const perTerm = terms.map(() =>
          `(LOWER(COALESCE(external_id,'')) LIKE ? OR LOWER(COALESCE(tracking_no,'')) LIKE ? OR LOWER(COALESCE(customer_phone,'')) LIKE ?)`
        );
        where += ` AND (${perTerm.join(' OR ')})`;
        for (const term of terms) {
          const q = `%${term}%`;
          params.push(q, q, q);
        }
      }
    }

    if (product && product !== 'all') {
      where += ` AND LOWER(COALESCE(note_product,'')) LIKE ?`;
      params.push(`%${String(product).toLowerCase()}%`);
    }

    if (pageFilter && pageFilter !== 'all') {
      where += ` AND page_name = ?`;
      params.push(String(pageFilter));
    }

    if (status && status !== 'all') {
      const statusToRaw = {
        New: ['new'],
        Confirmed: ['submitted'],
        'Waiting for pickup': ['pending', 'wait_print', 'waitting'],
        Shipped: ['shipped'],
        Delivered: ['delivered'],
        Returning: ['returning'],
        Returned: ['returned'],
        Canceled: ['canceled', 'removed'],
      };
      const rawStatuses = statusToRaw[status];
      if (rawStatuses) {
        where += ` AND status_name IN (${rawStatuses.map(() => '?').join(',')})`;
        params.push(...rawStatuses);
      }
    }

    if (tags && tags !== 'all') {
      where += ` AND LOWER(COALESCE(tags_json,'')) LIKE ?`;
      params.push(`%${String(tags).toLowerCase()}%`);
    }

    if (attempts && attempts !== 'all') {
      if (attempts === '4plus') {
        where += ` AND attempts >= 4`;
      } else if (attempts === '1') {
        // 1st attempt: orders not yet re-attempted (stored as 1, 0, or NULL).
        where += ` AND COALESCE(attempts, 0) <= 1`;
      } else {
        const n = Number(attempts);
        if (Number.isInteger(n)) { where += ` AND attempts = ?`; params.push(n); }
      }
    }

    // Prefer the original POS payload inserted_at when present. Some older
    // syncs wrote a bad inserted_at_remote value, so using the raw POS value
    // keeps the filter/counts aligned with Pancake POS without waiting for a
    // full re-sync to repair every row.
    const effectiveInsertedAt = db.type === 'postgres'
      ? "COALESCE(NULLIF(raw_payload::jsonb ->> 'inserted_at', ''), inserted_at_remote)"
      : "COALESCE(NULLIF(json_extract(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END, '$.inserted_at'), ''), inserted_at_remote)";

    // POS inserted_at is stored in UTC, but the dashboard's date filters use
    // the Manila business day. Convert UTC->Manila (+8h) before comparing, so an
    // order created during Manila 00:00-08:00 (still the previous UTC day) is
    // counted under the correct local day. Without this, ~a third of the
    // early-morning orders silently dropped out of "Today".
    const manilaDay = db.type === 'postgres'
      ? `to_char((${effectiveInsertedAt})::timestamp + interval '8 hours', 'YYYY-MM-DD')`
      : `date(${effectiveInsertedAt}, '+8 hours')`;
    const addDateFrom = (value) => {
      where += ` AND ${manilaDay} >= ?`;
      params.push(String(value).slice(0, 10));
    };
    const addDateTo = (value) => {
      where += ` AND ${manilaDay} <= ?`;
      params.push(String(value).slice(0, 10));
    };
    const padDate = (value) => String(value).padStart(2, '0');
    const formatDate = (date) => `${date.getFullYear()}-${padDate(date.getMonth() + 1)}-${padDate(date.getDate())}`;
    const addDays = (date, days) => {
      const next = new Date(date);
      next.setDate(next.getDate() + days);
      return next;
    };
    const addDateRange = (from, to) => {
      addDateFrom(from);
      addDateTo(to);
    };

    if (date_from || date_to) {
      if (date_from) addDateFrom(date_from);
      if (date_to) addDateTo(date_to);
    } else if (period === 'today') {
      addDateRange(formatDate(new Date()), formatDate(new Date()));
    } else if (period === 'yesterday') {
      const yesterday = addDays(new Date(), -1);
      addDateRange(formatDate(yesterday), formatDate(yesterday));
    } else if (period === 'month') {
      const now = new Date();
      addDateRange(formatDate(new Date(now.getFullYear(), now.getMonth(), 1)), formatDate(now));
    } else if (period === 'year') {
      const now = new Date();
      addDateRange(formatDate(new Date(now.getFullYear(), 0, 1)), formatDate(now));
    }

    // Courier partner-status filter (RMO "Undeliverable" tab).
    const { partner, update_period, update_date_from, update_date_to } = req.query;
    if (partner && partner !== 'all') {
      where += ` AND LOWER(COALESCE(partner_status,'')) = ?`;
      params.push(String(partner).toLowerCase());
    }

    // Last-status-update date filter — uses updated_at_remote (when the courier
    // status last changed), not the order's inserted date. Drives the
    // Undeliverable tab's Today/Yesterday quick filters. updated_at_remote is
    // stored in UTC, so shift to Manila (+8h) before comparing the day.
    const manilaUpdateDay = db.type === 'postgres'
      ? `to_char((updated_at_remote)::timestamp + interval '8 hours', 'YYYY-MM-DD')`
      : `date(updated_at_remote, '+8 hours')`;
    if (update_date_from || update_date_to) {
      if (update_date_from) { where += ` AND ${manilaUpdateDay} >= ?`; params.push(String(update_date_from).slice(0, 10)); }
      if (update_date_to) { where += ` AND ${manilaUpdateDay} <= ?`; params.push(String(update_date_to).slice(0, 10)); }
    } else if (update_period === 'today') {
      const t = formatDate(new Date());
      where += ` AND ${manilaUpdateDay} >= ? AND ${manilaUpdateDay} <= ?`;
      params.push(t, t);
    } else if (update_period === 'yesterday') {
      const y = formatDate(addDays(new Date(), -1));
      where += ` AND ${manilaUpdateDay} >= ? AND ${manilaUpdateDay} <= ?`;
      params.push(y, y);
    }

    // Undeliverable-reason options for the RMO Undeliverable/Returning tabs.
    // Computed BEFORE the reason filter is applied so picking one doesn't
    // collapse the dropdown to a single choice.
    const reasonOptionRows = await db.prepare(
      `SELECT DISTINCT partner_reason FROM pos_orders ${where} AND COALESCE(partner_reason,'') != ''`
    ).all(...params);
    const reasonOptions = reasonOptionRows
      .map((row) => row.partner_reason)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b)));

    // Reason filter (exact match on the stored partner_reason).
    const { reason } = req.query;
    if (reason && reason !== 'all') {
      where += ` AND COALESCE(partner_reason,'') = ?`;
      params.push(String(reason));
    }

    const statusCountRows = await db.prepare(`
      SELECT
        CASE
          WHEN status_name = 'new' THEN 'New'
          WHEN status_name = 'submitted' THEN 'Confirmed'
          WHEN status_name IN ('pending','wait_print','waitting') THEN 'Waiting for pickup'
          WHEN status_name = 'shipped'   THEN 'Shipped'
          WHEN status_name = 'delivered' THEN 'Delivered'
          WHEN status_name = 'returning' THEN 'Returning'
          WHEN status_name = 'returned'  THEN 'Returned'
          WHEN status_name IN ('canceled','removed') THEN 'Canceled'
          ELSE 'Other'
        END AS display_status,
        COUNT(*) AS count
      FROM pos_orders ${where}
      GROUP BY display_status
    `).all(...params);

    const total = statusCountRows.reduce((s, r) => s + Number(r.count || 0), 0);

    // Courier-status metrics over the same filtered set (not just the page).
    // Undeliverable = courier marked it undeliverable; Problematic = the latest
    // courier note reports a delivery failure.
    const undeliverableRow = await db.prepare(
      `SELECT COUNT(*) AS c FROM pos_orders ${where} AND LOWER(COALESCE(partner_status,'')) = 'undeliverable'`
    ).get(...params);
    const problematicRow = await db.prepare(
      `SELECT COUNT(*) AS c FROM pos_orders ${where} AND LOWER(COALESCE(courier_note,'')) LIKE '%fail%'`
    ).get(...params);
    const partnerCounts = {
      undeliverable: Number(undeliverableRow?.c || 0),
      problematic: Number(problematicRow?.c || 0),
    };

    const rows = await db.prepare(`
      SELECT external_id, shop_id, tracking_no, page_name, inserted_at_remote, ${effectiveInsertedAt} AS inserted_at_effective,
             updated_at_remote, customer_name, customer_phone,
             note_product, tags_json, attempts, cod, assigning_seller_name, status_name, sprinter_name, sprinter_tel,
             partner_json, shipping_address_json, assigned_to_user_id, assigned_to_name, psid, partner_status, courier_note, partner_reason
      FROM pos_orders ${where}
      ORDER BY ${effectiveInsertedAt} DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset);

    const filterOptionRows = await db.prepare(`
      SELECT note_product, page_name, tags_json
      FROM pos_orders ${where}
    `).all(...params);
    const filterOptions = filterOptionRows.reduce((acc, row) => {
      if (row.note_product) acc.products.add(row.note_product);
      if (row.page_name) acc.pages.add(row.page_name);
      parseJsonObject(row.tags_json, []).forEach((tag) => {
        const label = typeof tag === 'string' ? tag : (tag?.name || tag?.tag_name || tag?.label || '');
        if (label) acc.tags.add(label);
      });
      return acc;
    }, { products: new Set(), pages: new Set(), tags: new Set() });

    res.json({
      data: rows.map((row) => ({
        external_id: row.external_id,
        shop_id: row.shop_id,
        tracking_no: row.tracking_no,
        page_name: row.page_name,
        date: toManilaDate(row.inserted_at_effective || row.inserted_at_remote),
        inserted_at: row.inserted_at_effective || row.inserted_at_remote || null,
        updated_at: row.updated_at_remote || null,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        note_product: row.note_product,
        tags: parseJsonObject(row.tags_json, []),
        attempts: row.attempts,
        cod: row.cod,
        assigning_seller_name: row.assigning_seller_name,
        status_name: row.status_name,
        sprinter_name: row.sprinter_name,
        sprinter_tel: row.sprinter_tel,
        partner: parseJsonObject(row.partner_json, null),
        province: parseJsonObject(row.shipping_address_json, {})?.province_name || null,
        assigned_to_user_id: row.assigned_to_user_id != null ? Number(row.assigned_to_user_id) : null,
        assigned_to_name: row.assigned_to_name || null,
        can_message: Boolean(row.psid),
        partner_status: row.partner_status || null,
        courier_note: row.courier_note || null,
        partner_reason: row.partner_reason || null,
      })),
      status_counts: statusCountRows,
      partner_counts: partnerCounts,
      filter_options: {
        products: [...filterOptions.products].sort(),
        pages: [...filterOptions.pages].sort(),
        tags: [...filterOptions.tags].sort(),
        reasons: reasonOptions,
      },
      total,
      page: pageNum,
      per_page: perPage,
    });
  });

  // Lightweight user list for the RMO assignee dropdown. Unlike /auth/users this
  // is available to any authenticated user (RMO staff need it, they aren't admins).
  r.get('/assignable-users', async (req, res) => {
    const users = await db.prepare(`
      SELECT id, full_name, username, role
      FROM users
      WHERE is_active = 1
      ORDER BY full_name COLLATE NOCASE ASC
    `).all();
    res.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.full_name || u.username,
        role: u.role || null,
      })),
    });
  });

  // Assign (or clear) the dashboard user responsible for a POS order. Persisted on
  // pos_orders; the sync upsert never touches these columns, so it survives re-syncs.
  r.post('/pos-orders/:externalId/assignee', async (req, res) => {
    const externalId = String(req.params.externalId || '').trim();
    if (!externalId) return res.status(400).json({ error: 'Missing order id.' });
    const shopId = stringOrNull(req.body?.shop_id || req.body?.shopId);
    const rawUserId = req.body?.user_id;
    let userId = null;
    let name = null;
    if (rawUserId !== null && rawUserId !== undefined && String(rawUserId).trim() !== '') {
      userId = Number(rawUserId);
      if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user_id.' });
      const user = await db.prepare('SELECT id, full_name, username FROM users WHERE id = ? AND is_active = 1').get(userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      name = user.full_name || user.username;
    }
    const updateSql = shopId
      ? `UPDATE pos_orders
         SET assigned_to_user_id = ?, assigned_to_name = ?, updated_at = datetime('now')
         WHERE external_id = ? AND shop_id = ?`
      : `UPDATE pos_orders
         SET assigned_to_user_id = ?, assigned_to_name = ?, updated_at = datetime('now')
         WHERE external_id = ?`;
    const result = shopId
      ? await db.prepare(updateSql).run(userId, name, externalId, shopId)
      : await db.prepare(updateSql).run(userId, name, externalId);
    if (!result.changes) return res.status(404).json({ error: 'Order not found.' });
    res.json({ external_id: externalId, shop_id: shopId, assigned_to_user_id: userId, assigned_to_name: name });
  });

  // Per-customer notes (keyed by normalized phone). Append-only history so any
  // RMO/Logistics/Admin user can read past notes and add a new one. Stored apart
  // from pos_orders so it survives the 30-day order retention.
  const normalizeCustomerPhone = (raw) => {
    let digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('63') && digits.length === 12) digits = '0' + digits.slice(2);
    else if (digits.length === 10 && digits.startsWith('9')) digits = '0' + digits;
    return digits;
  };

  r.get('/customer-notes', async (req, res) => {
    const phone = normalizeCustomerPhone(req.query.phone);
    if (!phone) return res.json({ phone: '', notes: [] });
    const notes = await db.prepare(
      'SELECT id, note, author_id, author_name, created_at FROM customer_notes WHERE customer_phone = ? ORDER BY id DESC'
    ).all(phone);
    res.json({ phone, notes });
  });

  r.post('/customer-notes', async (req, res) => {
    const phone = normalizeCustomerPhone(req.body?.phone);
    const note = String(req.body?.note || '').trim();
    if (!phone) return res.status(400).json({ error: 'Missing customer phone.' });
    if (!note) return res.status(400).json({ error: 'Note cannot be empty.' });
    const authorId = req.user?.id || null;
    const authorName = req.user?.full_name || req.user?.username || 'Unknown';
    const result = await db.prepare(
      `INSERT INTO customer_notes (customer_phone, note, author_id, author_name) VALUES (?, ?, ?, ?)`
    ).run(phone, note.slice(0, 2000), authorId, authorName);
    res.json({ id: result.lastInsertRowid, phone, note, author_id: authorId, author_name: authorName });
  });

  // List the Botcake broadcast flows available to send for a shop/page, scoped to
  // a folder (defaults to the "UPDATE" folder). Used to populate the send dropdown.
  r.get('/pos-orders/botcake/flows', async (req, res) => {
    try {
      const result = await pancakePosSync.listBotcakeFlows(db, {
        shop_id: req.query.shop_id || req.query.shopId,
        folder_id: req.query.folder_id || req.query.folderId,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Send a Botcake flow to one or more order recipients on a single page.
  // Body: { shop_id, flow_id, orders: [{ external_id }] }
  r.post('/pos-orders/botcake/send', async (req, res) => {
    try {
      const body = req.body || {};
      const orders = Array.isArray(body.orders) ? body.orders : [];
      if (!body.flow_id && !body.flowId) return res.status(400).json({ error: 'Missing flow_id.' });
      if (!orders.length && !Array.isArray(body.psids)) return res.status(400).json({ error: 'No recipients selected.' });
      const result = await pancakePosSync.sendBotcakeFlow(db, body);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // List the order tags configured for a shop (to populate the tag editor).
  r.get('/pos-orders/tags', async (req, res) => {
    try {
      const result = await pancakePosSync.listShopOrderTags(db, { shop_id: req.query.shop_id || req.query.shopId });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Replace an order's tags and push the change back to Pancake POS.
  // Body: { shop_id, tags: [tagId, ...] }
  r.post('/pos-orders/:externalId/tags', async (req, res) => {
    try {
      const result = await pancakePosSync.updateOrderTags(db, {
        external_id: req.params.externalId,
        shop_id: req.body?.shop_id || req.body?.shopId,
        tags: req.body?.tags,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  r.delete('/pos-orders/no-contact', async (req, res) => {
    const result = await db.prepare(`
      DELETE FROM pos_orders
      WHERE (customer_phone IS NULL OR customer_phone = '')
        AND (customer_name IS NULL OR customer_name = '')
    `).run();
    res.json({ deleted: result.changes || 0 });
  });

  r.delete('/pos-raw/incomplete', async (req, res) => {
    const del = await db.prepare(`
      DELETE FROM pos_orders
      WHERE status_name IS NULL OR TRIM(status_name) = ''
    `).run();
    const linkDel = await db.prepare(`
      DELETE FROM integration_source_links
      WHERE provider = 'pancake_pos'
        AND entity_type = 'orders'
        AND local_table = 'orders'
        AND local_id NOT IN (SELECT CAST(id AS TEXT) FROM orders)
    `).run();
    res.json({ deleted_pos_orders: del.changes || 0, deleted_links: linkDel.changes || 0 });
  });

  r.post('/', async (req, res) => {
    const { customer, phone, product, tags, qty, cod_amount, status, courier, tracking_no, order_date } = req.body;
    const ref = `ORD-${Date.now()}`;
    const stmt = db.prepare(`INSERT INTO orders (order_ref,tracking_no,customer,phone,product,tags,qty,cod_amount,status,courier,order_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const result = await stmt.run(ref, tracking_no||null, customer, phone||null, product, tags||null, qty||1, cod_amount||0, status||'Confirmed', courier||null, order_date||new Date().toISOString().split('T')[0], req.user?.id||1);
    if (dispatch) dispatch('order.created', { id: result.lastInsertRowid, order_ref: ref, customer, product, status: status || 'Confirmed' });
    res.status(201).json({ id: result.lastInsertRowid, order_ref: ref });
  });

  r.post('/import', async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows to import' });

    let imported = 0;
    const failed_rows = [];
    const tx = db.transaction ? db.transaction((items) => items.forEach((item) => upsertOrder(item))) : null;
    const cleaned = [];

    rows.forEach((row, index) => {
      try {
        const item = cleanOrder(row, index);
        if (!item.customer || !item.product) throw new Error('Customer and product are required');
        cleaned.push(item);
      } catch (error) {
        failed_rows.push({ row_number: index + 2, error: error.message });
      }
    });

    try {
      if (tx) tx(cleaned);
      else await Promise.all(cleaned.map((item) => upsertOrder(item)));
      imported = cleaned.length;
    } catch (error) {
      return res.status(500).json({ error: error.message, failed_rows });
    }

    res.status(201).json({ imported, failed_rows });
  });

  r.put('/:id', async (req, res) => {
    const { status, tracking_no, courier, source_sheet, tags, order_date } = req.body;
    const next = (value) => value === undefined ? null : value;
    await db.prepare(`
      UPDATE orders
      SET status=COALESCE(?,status),
          tracking_no=COALESCE(?,tracking_no),
          courier=COALESCE(?,courier),
          source_sheet=COALESCE(?,source_sheet),
          tags=COALESCE(?,tags),
          order_date=COALESCE(?,order_date),
          updated_at=datetime('now')
      WHERE id=?
    `).run(next(status), next(tracking_no), next(courier), next(source_sheet), next(tags), next(order_date), req.params.id);
    if (dispatch) dispatch('order.updated', { id: req.params.id, status, tracking_no, courier });
    res.json({ success: true });
  });

  r.delete('/:id', async (req, res) => {
    await db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
    if (dispatch) dispatch('order.deleted', { id: req.params.id });
    res.json({ success: true });
  });

  return r;
}

/* ─── INVENTORY ───────────────────────────────────────────── */
function inventoryRoutes(db, { dispatch } = {}) {
  const r = express.Router();
  const allowedTypes = new Set(['Product', 'Supply']);

  const INVENTORY_WRITE_ROLES = new Set(['Administrator', 'Logistics']);
  function requireInventoryWrite(req, res, next) {
    if (!INVENTORY_WRITE_ROLES.has(String(req.user?.role || '').trim())) {
      return res.status(403).json({ error: 'Administrator or Logistics access required' });
    }
    return next();
  }

  function cleanInventoryItem(row = {}, index = 0) {
    const type = allowedTypes.has(row.type) ? row.type : 'Product';
    return {
      item_id: String(row.item_id || row.id || `${type === 'Product' ? 'P' : 'S'}IMP${index + 1}`).trim(),
      name: String(row.name || row.item_name || row.product || '').trim(),
      sku: String(row.sku || '').trim() || null,
      type,
      unit: String(row.unit || 'pcs').trim() || 'pcs',
      stock: Number.parseInt(row.stock || row.qty || row.quantity || 0, 10) || 0,
      reorder_pt: Number.parseInt(row.reorder_pt || row.reorder || 0, 10) || (type === 'Product' ? 200 : 15),
      cost_price: Number.parseFloat(row.cost_price || row.cost || 0) || 0,
      sell_price: row.sell_price || row.price ? Number.parseFloat(row.sell_price || row.price) || null : null,
    };
  }

  async function upsertInventoryItem(row, createdBy = 1) {
    // Capture prior stock so we can log the imported quantity as an "add"
    // (this is what feeds Total Orders). New item: prior = 0.
    const prior = await db.prepare('SELECT stock FROM inventory WHERE item_id=?').get(row.item_id);
    const priorStock = prior ? Number(prior.stock || 0) : 0;
    const newStock = Number(row.stock || 0);

    await db.prepare(`
      INSERT INTO inventory (item_id, name, sku, type, unit, stock, reorder_pt, cost_price, sell_price, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(item_id) DO UPDATE SET
        name = excluded.name,
        sku = excluded.sku,
        type = excluded.type,
        unit = excluded.unit,
        stock = excluded.stock,
        reorder_pt = excluded.reorder_pt,
        cost_price = excluded.cost_price,
        sell_price = excluded.sell_price,
        updated_at = datetime('now')
    `).run(
      row.item_id,
      row.name,
      row.sku,
      row.type,
      row.unit,
      row.stock,
      row.reorder_pt,
      row.cost_price,
      row.sell_price
    );

    // Log the positive delta so re-imports don't double-count Total Orders.
    const delta = newStock - priorStock;
    if (delta > 0) {
      await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(row.item_id, 'add', priorStock, delta, newStock, 'CSV import', createdBy);
    }
  }

  r.get('/', async (req, res) => {
    const { type } = req.query;
    // total_orders = cumulative stock added (item creation + stock-update "add" +
    // CSV import), summed from inventory_logs. Legacy items that were imported/set
    // before add-logging existed have no logs, so fall back to current stock.
    let sql = `
      SELECT i.*,
        COALESCE(
          NULLIF((SELECT SUM(l.qty_change) FROM inventory_logs l WHERE l.item_id = i.item_id AND l.action = 'add'), 0),
          i.stock,
          0
        ) AS total_orders
      FROM inventory i`;
    const params = [];
    if (type) { sql += ' WHERE i.type=?'; params.push(type); }
    res.json(await db.prepare(sql).all(...params));
  });

  r.get('/low-stock', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM inventory WHERE stock < reorder_pt').all());
  });

  // Stock update history (inventory_logs) for the Inventory "Stock History" tab.
  // Newest first. Optional ?item_id= filter; ?limit= caps rows (default 200).
  r.get('/logs', async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
    const params = [];
    let sql = `
      SELECT l.id, l.item_id, i.name AS item_name, i.unit,
             l.action, l.qty_before, l.qty_change, l.qty_after,
             l.notes, l.created_at, u.full_name AS created_by_name
      FROM inventory_logs l
      LEFT JOIN inventory i ON i.item_id = l.item_id
      LEFT JOIN users u ON u.id = l.created_by`;
    if (req.query.item_id) { sql += ' WHERE l.item_id = ?'; params.push(req.query.item_id); }
    sql += ' ORDER BY l.id DESC LIMIT ?';
    params.push(limit);
    res.json(await db.prepare(sql).all(...params));
  });

  // RTS Return page→SKU routing map.
  r.get('/rts-sku-map', async (req, res) => {
    res.json(await db.prepare('SELECT page_name, sku FROM rts_page_sku').all());
  });

  r.put('/rts-sku-map', requireInventoryWrite, async (req, res) => {
    const page_name = String(req.body?.page_name || '').trim();
    const sku = String(req.body?.sku || '').trim();
    if (!page_name) return res.status(400).json({ error: 'page_name required' });
    if (!sku) {
      await db.prepare('DELETE FROM rts_page_sku WHERE page_name=?').run(page_name);
      return res.json({ success: true, page_name, sku: '' });
    }
    await db.prepare(`
      INSERT INTO rts_page_sku (page_name, sku, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(page_name) DO UPDATE SET sku = excluded.sku, updated_at = datetime('now')
    `).run(page_name, sku);
    res.json({ success: true, page_name, sku });
  });

  r.post('/', requireInventoryWrite, async (req, res) => {
    const { name, sku, type, unit, stock, reorder_pt, cost_price, sell_price } = req.body;
    const item_id = `${type === 'Product' ? 'P' : 'S'}${String(Date.now()).slice(-4)}`;
    await db.prepare(`INSERT INTO inventory (item_id,name,sku,type,unit,stock,reorder_pt,cost_price,sell_price) VALUES (?,?,?,?,?,?,?,?,?)`).run(item_id, name, sku||null, type||'Product', unit||'pcs', stock||0, reorder_pt||(type==='Product'?200:15), cost_price||0, sell_price||null);
    // Log the initial stock as an "add" so it counts toward total_orders.
    const initStock = Number(stock || 0);
    if (initStock > 0) {
      await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(item_id, 'add', 0, initStock, initStock, 'Initial stock', req.user?.id||1);
    }
    res.status(201).json({ item_id });
  });

  r.post('/import', requireInventoryWrite, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows to import' });

    let imported = 0;
    const failed_rows = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try {
        const item = cleanInventoryItem(row, index);
        if (!item.name) throw new Error('Item name is required');
        await upsertInventoryItem(item, req.user?.id || 1);
        imported += 1;
      } catch (error) {
        failed_rows.push({ row_number: index + 2, error: error.message });
      }
    }

    res.status(201).json({ imported, failed_rows });
  });

  r.patch('/:item_id/stock', requireInventoryWrite, async (req, res) => {
    const { action, qty, notes } = req.body;
    const item = await db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let newStock = item.stock;
    if (action === 'add')    newStock = item.stock + qty;
    else if (action === 'remove') newStock = Math.max(0, item.stock - qty);
    else if (action === 'set')    newStock = qty;

    await db.prepare(`UPDATE inventory SET stock=?, updated_at=datetime('now') WHERE item_id=?`).run(newStock, req.params.item_id);
    await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`).run(req.params.item_id, action, item.stock, qty, newStock, notes||null, req.user?.id||1);
    if (dispatch) dispatch('inventory.updated', { item_id: req.params.item_id, name: item.name, action, qty_before: item.stock, qty_after: newStock });
    res.json({ success: true, new_stock: newStock });
  });

  // Update an item's reorder point (low-stock alert threshold).
  r.patch('/:item_id/reorder', requireInventoryWrite, async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const reorder_pt = Math.max(0, Number.parseInt(req.body?.reorder_pt, 10) || 0);
    await db.prepare(`UPDATE inventory SET reorder_pt=?, updated_at=datetime('now') WHERE item_id=?`).run(reorder_pt, req.params.item_id);
    if (dispatch) dispatch('inventory.updated', { item_id: req.params.item_id, name: item.name, reorder_pt });
    res.json({ success: true, reorder_pt });
  });

  // Edit an item's core details (name, sku, type, unit, cost price).
  r.patch('/:item_id', requireInventoryWrite, async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const name = (req.body?.name ?? item.name)?.toString().trim();
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    const sku = req.body?.sku === undefined ? item.sku : (req.body.sku?.toString().trim() || null);
    const type = req.body?.type === 'Supply' ? 'Supply' : (req.body?.type === 'Product' ? 'Product' : item.type);
    const unit = (req.body?.unit?.toString().trim()) || item.unit || 'pcs';
    const cost_price = req.body?.cost_price === undefined
      ? item.cost_price
      : (Number.parseFloat(req.body.cost_price) || 0);
    const sell_price = req.body?.sell_price === undefined || req.body.sell_price === null || req.body.sell_price === ''
      ? item.sell_price
      : (Number.parseFloat(req.body.sell_price) || 0);
    const stock = req.body?.stock === undefined || req.body.stock === null || req.body.stock === ''
      ? item.stock
      : Math.max(0, Number.parseInt(req.body.stock, 10) || 0);

    await db.prepare(`UPDATE inventory SET name=?, sku=?, type=?, unit=?, cost_price=?, sell_price=?, stock=?, updated_at=datetime('now') WHERE item_id=?`)
      .run(name, sku, type, unit, cost_price, sell_price, stock, req.params.item_id);
    // Keep the audit trail intact if stock was changed from the edit popup.
    if (stock !== item.stock) {
      await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(req.params.item_id, 'set', item.stock, stock - item.stock, stock, 'Edited via item details', req.user?.id||1);
    }
    if (dispatch) dispatch('inventory.updated', { item_id: req.params.item_id, name, sku, type, unit, cost_price, sell_price, stock });
    res.json({ success: true, item_id: req.params.item_id, name, sku, type, unit, cost_price, sell_price, stock });
  });

  // Toggle an item active (on) or closed (off).
  r.patch('/:item_id/active', requireInventoryWrite, async (req, res) => {
    const item = await db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const active = req.body?.active ? 1 : 0;
    await db.prepare(`UPDATE inventory SET active=?, updated_at=datetime('now') WHERE item_id=?`).run(active, req.params.item_id);
    if (dispatch) dispatch('inventory.updated', { item_id: req.params.item_id, name: item.name, active });
    res.json({ success: true, active });
  });

  return r;
}

/* ─── EXPENSES ────────────────────────────────────────────── */
function expensesRoutes(db) {
  const r = express.Router();
  const ALLOWED_CLASSIFICATIONS = new Set(['COGS', 'OPEX', 'CAPEX']);

  r.get('/', async (req, res) => {
    const { category, classification, search, page=1, per_page=25 } = req.query;
    let sql = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];
    if (category && category !== 'All') { sql += ' AND category=?'; params.push(category); }
    if (classification && classification !== 'All' && ALLOWED_CLASSIFICATIONS.has(classification)) {
      sql += ' AND classification=?';
      params.push(classification);
    }
    if (search) { sql += ' AND (item_name LIKE ? OR noted_by LIKE ?)'; const q=`%${search}%`; params.push(q,q); }
    const total = (await db.prepare(`SELECT COUNT(*) as c ${sql.slice(sql.indexOf('FROM'))}`).get(...params)).c;
    sql += ' ORDER BY exp_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data: await db.prepare(sql).all(...params), total });
  });

  r.post('/', async (req, res) => {
    const { exp_date, category, classification, item_name, quantity, unit_price, noted_by } = req.body;
    if (!category || !item_name || !unit_price) return res.status(400).json({ error: 'Required fields missing' });
    const cls = ALLOWED_CLASSIFICATIONS.has(classification) ? classification : 'OPEX';
    const ref = `EXP-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO expenses (expense_ref,exp_date,category,classification,item_name,quantity,unit_price,noted_by,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(ref, exp_date||new Date().toISOString().split('T')[0], category, cls, item_name, quantity||1, unit_price, noted_by||null, req.user?.id||1);
    res.status(201).json({ expense_ref: ref });
  });

  r.delete('/:id', async (req, res) => {
    await db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  r.get('/credits/list', async (req, res) => {
    const { page = 1, per_page = 50 } = req.query;
    const perPage = Math.min(200, Math.max(10, parseInt(per_page, 10) || 50));
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * perPage;
    const total = (await db.prepare('SELECT COUNT(*) AS c FROM expense_credits').get()).c;
    const data = await db.prepare('SELECT * FROM expense_credits ORDER BY credit_date DESC, id DESC LIMIT ? OFFSET ?').all(perPage, offset);
    res.json({ data, total });
  });

  r.post('/credits', async (req, res) => {
    const { credit_date, amount, source, notes } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    const ref = `CR-${String(Date.now()).slice(-6)}`;
    await db.prepare('INSERT INTO expense_credits (credit_ref, credit_date, amount, source, notes, created_by) VALUES (?,?,?,?,?,?)').run(
      ref,
      credit_date || new Date().toISOString().split('T')[0],
      amt,
      source || null,
      notes || null,
      req.user?.id || null,
    );
    res.status(201).json({ credit_ref: ref });
  });

  r.delete('/credits/:id', async (req, res) => {
    await db.prepare('DELETE FROM expense_credits WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return r;
}

/* ─── DAILY PICKUPS ───────────────────────────────────────── */
function pickupsRoutes(db) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { page=1, per_page=25 } = req.query;
    const total = (await db.prepare('SELECT COUNT(*) as c FROM daily_pickups').get()).c;
    const data = await db.prepare('SELECT * FROM daily_pickups ORDER BY pickup_date DESC LIMIT ? OFFSET ?').all(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data, total });
  });

  r.post('/', async (req, res) => {
    const { pickup_date, product_name, product_type, customer_orders, total_pieces, notes } = req.body;
    if (!product_name || !customer_orders || !total_pieces) return res.status(400).json({ error: 'Required fields missing' });
    const ref = `PU-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO daily_pickups (pickup_ref,pickup_date,product_name,product_type,customer_orders,total_pieces,notes,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(ref, pickup_date||new Date().toISOString().split('T')[0], product_name, product_type||'Product', customer_orders, total_pieces, notes||null, req.user?.id||1);
    res.status(201).json({ pickup_ref: ref });
  });

  return r;
}

/* ─── SCANS ───────────────────────────────────────────────── */
function scansRoutes(db) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { type, page=1, per_page=50, search, status, date_from, date_to } = req.query;
    const where = ['1=1'];
    const params = [];
    if (type) { where.push('s.scan_type = ?'); params.push(type); }
    if (status) { where.push('LOWER(TRIM(COALESCE(s.status, p.status_name))) = LOWER(?)'); params.push(status); }
    if (date_from) { where.push('s.scan_date >= ?'); params.push(date_from); }
    if (date_to)   { where.push('s.scan_date <= ?'); params.push(date_to); }
    if (search) {
      where.push('(s.tracking_no LIKE ? OR s.customer LIKE ? OR s.phone LIKE ? OR p.note_product LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const baseFrom = `
      FROM scan_records s
      LEFT JOIN pos_orders p ON LOWER(p.tracking_no) = LOWER(s.tracking_no)
    `;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(10, parseInt(per_page, 10) || 50));
    const offset = (pageNum - 1) * perPage;

    const totalRow = await db.prepare(`SELECT COUNT(*) AS c ${baseFrom} ${whereSql}`).get(...params);
    const total = totalRow?.c || 0;

    const data = await db.prepare(`
      SELECT s.id, s.scan_ref, s.tracking_no, s.customer, s.phone,
             s.scan_date, s.scan_time, s.status, s.courier, s.scan_type, s.created_at,
             p.note_product AS product_name, NULL AS province_city, p.cod, p.page_name AS chat_page
      ${baseFrom} ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset);

    // Lightweight rows for client-agnostic pcs aggregation. Leading-digit parse
    // ("2 Niacinamide" → 2, no leading digits → 1 pc) is hard to write portably
    // across SQLite + Postgres, so we ship the three needed fields and roll up
    // in JS. Egress stays modest — only status / product_name / chat_page.
    const summaryRows = await db.prepare(`
      SELECT
        TRIM(COALESCE(NULLIF(TRIM(s.status), ''), p.status_name)) AS status,
        p.note_product AS product_name,
        p.page_name AS chat_page
      ${baseFrom} ${whereSql}
    `).all(...params);

    const extractLeadingPcs = (name) => {
      const m = String(name || '').match(/^\s*(\d+)/);
      return m ? Math.min(10000, parseInt(m[1], 10)) : 1;
    };
    // Product name with the leading pcs count stripped ("2 Niacinamide" → "niacinamide"),
    // used to roll pcs up per product so the inventory page can match by item name.
    const productKey = (name) => String(name || '').replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const pcsByStatus = new Map();
    const pcsByPage = new Map();
    const scansByPage = new Map();
    const pcsByProduct = new Map();
    const pcsByPageProduct = new Map(); // page -> Map(productKey -> { name, pcs })
    let totalPcs = 0;
    for (const r of summaryRows) {
      const pcs = extractLeadingPcs(r.product_name);
      const status = r.status || 'Unknown';
      const chatPage = r.chat_page || 'Unknown';
      const product = productKey(r.product_name);
      pcsByStatus.set(status, (pcsByStatus.get(status) || 0) + pcs);
      pcsByPage.set(chatPage, (pcsByPage.get(chatPage) || 0) + pcs);
      scansByPage.set(chatPage, (scansByPage.get(chatPage) || 0) + 1);
      if (product) {
        pcsByProduct.set(product, (pcsByProduct.get(product) || 0) + pcs);
        if (!pcsByPageProduct.has(chatPage)) pcsByPageProduct.set(chatPage, new Map());
        const pm = pcsByPageProduct.get(chatPage);
        const prev = pm.get(product) || { name: r.product_name || product, pcs: 0 };
        prev.pcs += pcs;
        if (!prev.name && r.product_name) prev.name = r.product_name;
        pm.set(product, prev);
      }
      totalPcs += pcs;
    }
    const by_status = Array.from(pcsByStatus, ([status, pcs]) => ({ status, pcs }))
      .sort((a, b) => b.pcs - a.pcs);
    const by_page = Array.from(pcsByPage, ([page, pcs]) => ({
      page,
      pcs,
      scans: scansByPage.get(page) || 0,
    })).sort((a, b) => b.scans - a.scans);
    const by_product = Array.from(pcsByProduct, ([product, pcs]) => ({ product, pcs }))
      .sort((a, b) => b.pcs - a.pcs);
    const by_page_product = Array.from(pcsByPageProduct, ([page, pm]) => ({
      page,
      products: Array.from(pm, ([product, v]) => ({ product, name: v.name, pcs: v.pcs }))
        .sort((a, b) => b.pcs - a.pcs),
    }));

    res.json({
      data,
      total,
      page: pageNum,
      per_page: perPage,
      pages: Math.ceil(total / perPage),
      summary: { by_status, by_page, by_product, by_page_product, total_pcs: totalPcs },
    });
  });

  r.get('/lookup/:tracking', async (req, res) => {
    const tracking = req.params.tracking.trim();
    if (!tracking) return res.status(400).json({ error: 'Tracking number required' });

    const found = await db.prepare(`
      SELECT s.tracking_no, s.customer, s.phone, s.status, s.courier, s.scan_date,
             p.note_product AS product_name, NULL AS province_city, p.cod
      FROM scan_records s
      LEFT JOIN pos_orders p ON LOWER(p.tracking_no) = LOWER(s.tracking_no)
      WHERE LOWER(s.tracking_no) = LOWER(?)
      ORDER BY s.created_at DESC
      LIMIT 1
    `).get(tracking);
    if (found) return res.json(found);

    const posRow = await db.prepare(`
      SELECT tracking_no, customer_name, customer_phone, status_name, cod,
             note_product, sprinter_name, partner_json, shipping_address_json,
             substr(inserted_at_remote, 1, 10) AS scan_date
      FROM pos_orders
      WHERE LOWER(tracking_no) = LOWER(?)
      LIMIT 1
    `).get(tracking);
    if (posRow) {
      const tryJson = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || {}); } catch { return {}; } };
      const pickKey = (obj, keys) => { for (const k of keys) { const v = obj?.[k]; if (v && String(v).trim()) return String(v).trim(); } return ''; };
      const POS_STATUS = { new: 'New', submitted: 'Confirmed', pending: 'Waiting for pickup', wait_print: 'Waiting for pickup', waitting: 'Waiting for pickup', shipped: 'Shipped', delivered: 'Delivered', returning: 'Returning', returned: 'Returned', canceled: 'Canceled', removed: 'Canceled' };
      const partner = tryJson(posRow.partner_json);
      const shipping = tryJson(posRow.shipping_address_json);
      const courier = (partner?.partner_name || partner?.name || posRow.sprinter_name || '').trim();
      const province = pickKey(shipping, ['province', 'province_name', 'state', 'region', 'city', 'city_name']);
      const statusName = String(posRow.status_name || '').toLowerCase();
      const status = POS_STATUS[statusName] || (posRow.status_name ? posRow.status_name.charAt(0).toUpperCase() + posRow.status_name.slice(1) : 'New');
      return res.json({
        tracking_no: posRow.tracking_no,
        customer: posRow.customer_name || 'Unknown Customer',
        phone: posRow.customer_phone || '',
        status,
        courier,
        scan_date: posRow.scan_date,
        product_name: posRow.note_product || '',
        province_city: province,
        cod: posRow.cod,
      });
    }

    return res.status(404).json({ error: 'Tracking number not found', tracking_no: tracking });
  });

  r.post('/', async (req, res) => {
    const { tracking_no, customer, phone, status, courier, scan_type, scan_date } = req.body;
    if (!tracking_no) return res.status(400).json({ error: 'Tracking number required' });
    const today = scan_date || new Date().toISOString().split('T')[0];
    const type = scan_type || 'Standard';
    const duplicate = await db.prepare(
      `SELECT id FROM scan_records WHERE LOWER(tracking_no) = LOWER(?) AND scan_type = ? AND scan_date = ? LIMIT 1`
    ).get(tracking_no, type, today);
    if (duplicate) return res.status(409).json({ error: 'Already scanned', message: `${tracking_no} was already scanned today.` });
    const ref = `SCN-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO scan_records (scan_ref,tracking_no,customer,phone,scan_date,status,courier,scan_type,scanned_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(ref, tracking_no, customer||null, phone||null, today, status||null, courier||null, type, req.user?.id||1);
    res.status(201).json({ scan_ref: ref });
  });

  // RTS Return: record a returned item and add it back into stock. Each tracking
  // is counted only once (all-time dedup) so stock is never double-incremented.
  r.post('/rts-return', async (req, res) => {
    const { tracking_no, scan_date } = req.body;
    if (!tracking_no) return res.status(400).json({ error: 'Tracking number required' });
    const today = scan_date || new Date().toISOString().split('T')[0];
    const TYPE = 'RTS Return';

    const duplicate = await db.prepare(
      `SELECT id FROM scan_records WHERE LOWER(tracking_no) = LOWER(?) AND scan_type = ? LIMIT 1`
    ).get(tracking_no, TYPE);
    if (duplicate) {
      return res.status(409).json({ error: 'Already scanned', message: `${tracking_no} was already returned and will not be counted again.` });
    }

    // Pull product/customer from the matching POS order (if any).
    const posRow = await db.prepare(`
      SELECT tracking_no, customer_name, customer_phone, note_product
      FROM pos_orders WHERE LOWER(tracking_no) = LOWER(?) LIMIT 1
    `).get(tracking_no);
    const productName = posRow?.note_product || '';
    const customer = posRow?.customer_name || 'Unknown Customer';
    const phone = posRow?.customer_phone || '';

    // pcs = leading number in the product name ("2 Niacinamide" -> 2), else 1.
    const pcsMatch = String(productName).match(/^\s*(\d+)/);
    const pcs = pcsMatch ? Math.min(10000, parseInt(pcsMatch[1], 10)) : 1;

    // Record the scan.
    const ref = `RTR-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO scan_records (scan_ref,tracking_no,customer,phone,scan_date,status,courier,scan_type,scanned_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ref, tracking_no, customer, phone, today, 'RTS Return', null, TYPE, req.user?.id || 1);

    // Match an inventory Product by normalized name and add the pcs back to stock.
    const norm = (name) => String(name || '').replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const key = norm(productName);
    let matched = null;
    if (key) {
      const items = await db.prepare(`SELECT item_id, name, stock FROM inventory WHERE type = 'Product'`).all();
      const hit = items.find((it) => norm(it.name) === key);
      if (hit) {
        const before = Number(hit.stock || 0);
        const after = before + pcs;
        await db.prepare(`UPDATE inventory SET stock=?, updated_at=datetime('now') WHERE item_id=?`).run(after, hit.item_id);
        await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
          .run(hit.item_id, 'add', before, pcs, after, `RTS Return scan ${tracking_no}`, req.user?.id || 1);
        matched = { item_id: hit.item_id, name: hit.name, new_stock: after };
      }
    }

    res.status(201).json({
      scan_ref: ref,
      tracking_no,
      customer,
      product_name: productName,
      pcs,
      matched_item: matched,
    });
  });

  return r;
}

/* ─── CSR DAILY RECORDS ───────────────────────────────────── */
function csrRoutes(db) {
  const r = express.Router();

  // Roles allowed to see every CSR entry. Everyone else only sees their own.
  const VIEW_ALL_ROLES = new Set([
    'Administrator', 'CSR TL', 'Logistics', 'Sales and Marketing', 'Sales and Marketing TL',
  ]);
  const role = (req) => String(req.user?.role || '').trim();
  const canViewAll = (req) => VIEW_ALL_ROLES.has(role(req));
  const isAdmin = (req) => role(req) === 'Administrator';
  const userId = (req) => req.user?.id || 0;

  function mapRow(row) {
    return {
      id: row.record_ref,
      date: row.record_date,
      csrName: row.csr_name || '',
      pageName: row.page_name || '',
      orderId: row.order_id || '',
      customerName: row.customer_name || '',
      cellphoneNumber: row.cellphone_number || '',
      salesType: row.sales_type || '',
      status: row.status || '',
      price: Number(row.price || 0),
      trackingNumber: row.tracking_number || '',
    };
  }

  function cleanInput(body = {}) {
    return {
      record_date: String(body.date || '').slice(0, 10),
      csr_name: String(body.csrName || '').trim(),
      page_name: String(body.pageName || '').trim(),
      order_id: String(body.orderId || '').trim(),
      customer_name: String(body.customerName || '').trim(),
      cellphone_number: String(body.cellphoneNumber || '').trim(),
      sales_type: String(body.salesType || '').trim(),
      status: String(body.status || '').trim(),
      price: Number.parseFloat(body.price) || 0,
      tracking_number: String(body.trackingNumber || '').trim() || null,
    };
  }

  function isValid(input) {
    return Boolean(input.record_date && input.page_name && input.order_id && input.sales_type);
  }

  let refCounter = 0;
  function newRef() {
    refCounter = (refCounter + 1) % 100000;
    return `CSR-${Date.now()}${String(refCounter).padStart(5, '0')}`;
  }

  async function insertRecord(input, createdBy) {
    const ref = newRef();
    await db.prepare(`
      INSERT INTO csr_records (
        record_ref, record_date, csr_name, page_name, order_id, customer_name,
        cellphone_number, sales_type, status, price, tracking_number, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, input.record_date, input.csr_name, input.page_name, input.order_id,
      input.customer_name, input.cellphone_number, input.sales_type, input.status,
      input.price, input.tracking_number, createdBy
    );
    return ref;
  }

  r.get('/', async (req, res) => {
    const where = [];
    const params = [];
    if (!canViewAll(req)) { where.push('created_by = ?'); params.push(userId(req)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.prepare(
      `SELECT * FROM csr_records ${whereSql} ORDER BY record_date DESC, id DESC`
    ).all(...params);
    res.json({ data: rows.map(mapRow) });
  });

  // Returns all active CSR/Trainee user names — used to populate the Name filter
  // even for agents who have not yet submitted any records.
  r.get('/agents', async (req, res) => {
    const rows = await db.prepare(`
      SELECT COALESCE(NULLIF(full_name,''), username) AS name
      FROM users
      WHERE is_active = 1 AND role IN ('CSR', 'CSR TL', 'Trainee')
      ORDER BY name COLLATE NOCASE ASC
    `).all();
    res.json({ names: rows.map((r) => r.name).filter(Boolean) });
  });

  r.post('/', async (req, res) => {
    const input = cleanInput(req.body);
    if (!isValid(input)) {
      return res.status(400).json({ error: 'date, pageName, orderId, and salesType are required' });
    }
    const ref = await insertRecord(input, userId(req));
    const row = await db.prepare('SELECT * FROM csr_records WHERE record_ref = ?').get(ref);
    res.status(201).json(mapRow(row));
  });

  r.put('/:ref', async (req, res) => {
    const row = await db.prepare('SELECT * FROM csr_records WHERE record_ref = ?').get(req.params.ref);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    if (!isAdmin(req) && row.created_by !== userId(req)) {
      return res.status(403).json({ error: 'You can only edit your own CSR records' });
    }
    const input = cleanInput(req.body);
    if (!isValid(input)) {
      return res.status(400).json({ error: 'date, pageName, orderId, and salesType are required' });
    }
    await db.prepare(`
      UPDATE csr_records
      SET record_date = ?, csr_name = ?, page_name = ?, order_id = ?, customer_name = ?,
          cellphone_number = ?, sales_type = ?, status = ?, price = ?, tracking_number = ?,
          updated_at = datetime('now')
      WHERE record_ref = ?
    `).run(
      input.record_date, input.csr_name, input.page_name, input.order_id, input.customer_name,
      input.cellphone_number, input.sales_type, input.status, input.price, input.tracking_number,
      req.params.ref
    );
    const updated = await db.prepare('SELECT * FROM csr_records WHERE record_ref = ?').get(req.params.ref);
    res.json(mapRow(updated));
  });

  r.delete('/:ref', async (req, res) => {
    const row = await db.prepare('SELECT * FROM csr_records WHERE record_ref = ?').get(req.params.ref);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    if (!isAdmin(req) && row.created_by !== userId(req)) {
      return res.status(403).json({ error: 'You can only delete your own CSR records' });
    }
    await db.prepare('DELETE FROM csr_records WHERE record_ref = ?').run(req.params.ref);
    res.json({ success: true });
  });

  // One-time import used to migrate records that were stranded in a user's
  // browser localStorage before CSR records were stored server-side.
  r.post('/import', async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let imported = 0;
    for (const raw of rows) {
      const input = cleanInput(raw);
      // Lenient on purpose: preserve legacy rows even if they predate the
      // Order ID / sales-type fields. Skip only truly empty entries.
      if (!input.record_date && !input.customer_name && !input.order_id) continue;
      await insertRecord(input, userId(req));
      imported += 1;
    }
    res.status(201).json({ imported });
  });

  return r;
}

module.exports = ordersRoutes;
module.exports.ordersRoutes    = ordersRoutes;
module.exports.inventoryRoutes = inventoryRoutes;
module.exports.expensesRoutes  = expensesRoutes;
module.exports.pickupsRoutes   = pickupsRoutes;
module.exports.scansRoutes     = scansRoutes;
module.exports.csrRoutes       = csrRoutes;
