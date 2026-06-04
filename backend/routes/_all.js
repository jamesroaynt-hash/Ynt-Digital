/* ─── ORDERS ──────────────────────────────────────────────── */
const express = require('express');
const googleSheetsSync = require('../services/googleSheetsSync');

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

  r.get('/', async (req, res) => {
    const { status, filter, search, page=1, per_page=10, source_sheet, month, year } = req.query;
    const perPage = Math.max(1, Math.min(100, parseInt(per_page) || 10));
    const pageNum = Math.max(1, parseInt(page) || 1);
    const offset  = (pageNum - 1) * perPage;

    const where  = [];
    const params = [];

    if (status && status !== 'All') { where.push('o.status = ?'); params.push(status); }
    if (source_sheet && source_sheet !== 'all') {
      where.push("(o.source_sheet = ? OR (o.source_sheet IS NULL AND ? = ''))");
      params.push(source_sheet, source_sheet);
    }
    if (month && month !== 'all') {
      const y = year && year !== 'all' ? Number(year) : new Date().getUTCFullYear();
      const m = Math.max(1, Math.min(12, Number(month)));
      const start = `${y}-${String(m).padStart(2,'0')}-01`;
      const end   = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2,'0')}-01`;
      where.push('o.order_date >= ? AND o.order_date < ?');
      params.push(start, end);
    } else if (year && year !== 'all') {
      where.push('o.order_date >= ? AND o.order_date < ?');
      params.push(`${year}-01-01`, `${Number(year) + 1}-01-01`);
    }
    if (filter === 'weekly') { where.push("o.order_date >= date('now','-7 days')"); }
    if (filter === 'monthly') {
      const now = new Date();
      where.push('o.order_date >= ?');
      params.push(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2,'0')}-01`);
    }
    if (filter === 'yearly') {
      where.push('o.order_date >= ?');
      params.push(`${new Date().getUTCFullYear()}-01-01`);
    }
    if (search) {
      where.push(`(o.customer LIKE ? OR o.order_ref LIKE ? OR o.tracking_no LIKE ?
                  OR o.courier LIKE ? OR o.source_sheet LIKE ? OR o.tags LIKE ?)`);
      const q = `%${search}%`;
      params.push(q, q, q, q, q, q);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Cheap COUNT: no joins, no subqueries.
    const total = (await db.prepare(
      `SELECT COUNT(*) AS c FROM orders o ${whereSql}`
    ).get(...params)).c;

    // CAST is on the constant (per-row) side so isl.local_id stays bare and
    // the idx_isl_orders_lookup composite index can resolve the join.
    const rows = await db.prepare(`
      SELECT
        o.id, o.order_ref, o.tracking_no, o.customer, o.phone, o.product,
        o.tags, o.qty, o.cod_amount, o.status, o.courier, o.source_sheet,
        o.attempts, o.order_date, o.confirmed_by, o.created_by,
        o.created_at, o.updated_at,
        po.tags_json             AS pos_tags_json,
        po.shipping_address_json AS pos_shipping_address_json,
        po.raw_payload           AS pos_raw_payload
      FROM orders o
      LEFT JOIN integration_source_links isl
        ON  isl.local_table = 'orders'
        AND isl.entity_type = 'orders'
        AND isl.provider    = 'pancake_pos'
        AND isl.local_id    = CAST(o.id AS TEXT)
      LEFT JOIN pos_orders po ON po.external_id = isl.external_id
      ${whereSql}
      ORDER BY o.order_date DESC, o.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset);

    res.json({
      data: enrichOrderReportMeta(await normalizeOrderPageNames(rows)),
      total,
      page: pageNum,
      per_page: perPage,
    });
  });

  r.get('/stats', async (req, res) => {
    const counts = await db.prepare(`SELECT status, COUNT(*) as count, SUM(cod_amount) as total_cod FROM orders GROUP BY status`).all();
    const total_orders = (await db.prepare(`SELECT COUNT(*) as count FROM orders`).get()).count || 0;
    const total_cod = (await db.prepare(`SELECT SUM(cod_amount) as total FROM orders`).get()).total || 0;
    res.json({ status_counts: counts, total_orders, total_cod });
  });

  r.get('/summary', async (req, res) => {
    const { search, source_sheet, product, pos_tag, month, year, date_filter, date_from, date_to } = req.query;
    const where  = [];
    const params = [];

    if (source_sheet && source_sheet !== 'all') {
      where.push("(o.source_sheet = ? OR (o.source_sheet IS NULL AND ? = ''))");
      params.push(source_sheet, source_sheet);
    }
    if (product && product !== 'all') { where.push('o.product = ?'); params.push(product); }
    if (month && month !== 'all') {
      const y = year && year !== 'all' ? Number(year) : new Date().getUTCFullYear();
      const m = Math.max(1, Math.min(12, Number(month)));
      const start = `${y}-${String(m).padStart(2,'0')}-01`;
      const end   = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2,'0')}-01`;
      where.push('o.order_date >= ? AND o.order_date < ?');
      params.push(start, end);
    } else if (year && year !== 'all') {
      where.push('o.order_date >= ? AND o.order_date < ?');
      params.push(`${year}-01-01`, `${Number(year) + 1}-01-01`);
    }
    if (date_filter === 'today')     { where.push("o.order_date = date('now')"); }
    if (date_filter === 'yesterday') { where.push("o.order_date = date('now','-1 day')"); }
    if (date_filter === 'month') {
      const now = new Date();
      where.push('o.order_date >= ?');
      params.push(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2,'0')}-01`);
    }
    if (date_filter === 'year') {
      where.push('o.order_date >= ?');
      params.push(`${new Date().getUTCFullYear()}-01-01`);
    }
    if (date_filter === 'custom') {
      if (date_from) { where.push('o.order_date >= ?'); params.push(String(date_from).slice(0, 10)); }
      if (date_to)   { where.push('o.order_date <= ?'); params.push(String(date_to).slice(0, 10)); }
    }
    if (search) {
      where.push(`(
        LOWER(COALESCE(o.customer, '')) LIKE ?
        OR LOWER(COALESCE(o.order_ref, '')) LIKE ?
        OR LOWER(COALESCE(o.tracking_no, '')) LIKE ?
        OR LOWER(COALESCE(o.phone, '')) LIKE ?
        OR LOWER(COALESCE(o.product, '')) LIKE ?
        OR LOWER(COALESCE(o.courier, '')) LIKE ?
        OR LOWER(COALESCE(o.source_sheet, '')) LIKE ?
        OR LOWER(COALESCE(o.tags, '')) LIKE ?
        OR LOWER(COALESCE(o.confirmed_by, '')) LIKE ?
      )`);
      const q = `%${String(search).toLowerCase()}%`;
      params.push(q, q, q, q, q, q, q, q, q);
    }

    // Only join into pos_orders when the pos_tag filter is actually used.
    let join = '';
    if (pos_tag && pos_tag !== 'all') {
      join = `
        LEFT JOIN integration_source_links isl
          ON  isl.local_table = 'orders'
          AND isl.entity_type = 'orders'
          AND isl.provider    = 'pancake_pos'
          AND isl.local_id    = CAST(o.id AS TEXT)
        LEFT JOIN pos_orders po ON po.external_id = isl.external_id`;
      where.push("LOWER(COALESCE(po.tags_json, '')) LIKE ?");
      params.push(`%${String(pos_tag).toLowerCase()}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.prepare(`
      SELECT o.status AS status,
             COUNT(*) AS count,
             COALESCE(SUM(o.cod_amount), 0) AS total_cod
      FROM orders o
      ${join}
      ${whereSql}
      GROUP BY o.status
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
      submitted: 'New', new: 'New', pending: 'New', wait_print: 'New',
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
          date: (row.inserted_at_remote || '').slice(0, 10),
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

  r.get('/pos-orders', async (req, res) => {
    const {
      page = 1, per_page = 50,
      search, product, source: pageFilter, status, tags,
      period, date_from, date_to,
    } = req.query;
    const perPage = Math.max(1, Math.min(100, Number(per_page) || 50));
    const pageNum = Math.max(1, Number(page) || 1);
    const offset = (pageNum - 1) * perPage;
    const params = [];

    let where = "WHERE customer_phone IS NOT NULL AND customer_phone != ''";

    if (search) {
      where += ` AND (LOWER(COALESCE(external_id,'')) LIKE ? OR LOWER(COALESCE(tracking_no,'')) LIKE ? OR LOWER(COALESCE(customer_phone,'')) LIKE ?)`;
      const q = `%${String(search).toLowerCase()}%`;
      params.push(q, q, q);
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
        New: ['submitted', 'new', 'pending', 'wait_print'],
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

    const addDateFrom = (value) => {
      where += ` AND substr(COALESCE(inserted_at_remote,''), 1, 10) >= ?`;
      params.push(String(value).slice(0, 10));
    };
    const addDateTo = (value) => {
      where += ` AND substr(COALESCE(inserted_at_remote,''), 1, 10) <= ?`;
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

    const statusCountRows = await db.prepare(`
      SELECT
        CASE
          WHEN status_name IN ('submitted','new','pending','wait_print') THEN 'New'
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

    const rows = await db.prepare(`
      SELECT external_id, tracking_no, page_name, inserted_at_remote, customer_name, customer_phone,
             note_product, tags_json, attempts, cod, assigning_seller_name, status_name, sprinter_name, sprinter_tel,
             partner_json
      FROM pos_orders ${where}
      ORDER BY inserted_at_remote DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset);

    res.json({
      data: rows.map((row) => ({
        external_id: row.external_id,
        tracking_no: row.tracking_no,
        page_name: row.page_name,
        date: (row.inserted_at_remote || '').slice(0, 10),
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
      })),
      status_counts: statusCountRows,
      total,
      page: pageNum,
      per_page: perPage,
    });
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

  async function upsertInventoryItem(row) {
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
  }

  r.get('/', async (req, res) => {
    const { type } = req.query;
    let sql = 'SELECT * FROM inventory';
    const params = [];
    if (type) { sql += ' WHERE type=?'; params.push(type); }
    res.json(await db.prepare(sql).all(...params));
  });

  r.get('/low-stock', async (req, res) => {
    res.json(await db.prepare('SELECT * FROM inventory WHERE stock < reorder_pt').all());
  });

  r.post('/', requireInventoryWrite, async (req, res) => {
    const { name, sku, type, unit, stock, reorder_pt, cost_price, sell_price } = req.body;
    const item_id = `${type === 'Product' ? 'P' : 'S'}${String(Date.now()).slice(-4)}`;
    await db.prepare(`INSERT INTO inventory (item_id,name,sku,type,unit,stock,reorder_pt,cost_price,sell_price) VALUES (?,?,?,?,?,?,?,?,?)`).run(item_id, name, sku||null, type||'Product', unit||'pcs', stock||0, reorder_pt||(type==='Product'?200:15), cost_price||0, sell_price||null);
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
        await upsertInventoryItem(item);
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
    if (status) { where.push('LOWER(TRIM(COALESCE(s.status, g.status))) = LOWER(?)'); params.push(status); }
    if (date_from) { where.push('s.scan_date >= ?'); params.push(date_from); }
    if (date_to)   { where.push('s.scan_date <= ?'); params.push(date_to); }
    if (search) {
      where.push('(s.tracking_no LIKE ? OR s.customer LIKE ? OR s.phone LIKE ? OR g.product_name LIKE ? OR g.province_city LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const baseFrom = `
      FROM scan_records s
      LEFT JOIN google_orders g ON LOWER(g.tracking_no) = LOWER(s.tracking_no)
    `;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(10, parseInt(per_page, 10) || 50));
    const offset = (pageNum - 1) * perPage;

    const totalRow = await db.prepare(`SELECT COUNT(*) AS c ${baseFrom} ${whereSql}`).get(...params);
    const total = totalRow?.c || 0;

    const data = await db.prepare(`
      SELECT s.id, s.scan_ref, s.tracking_no, s.customer, s.phone,
             s.scan_date, s.scan_time, s.status, s.courier, s.scan_type, s.created_at,
             g.product_name, g.province_city, g.cod, g.chat_page
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
        TRIM(COALESCE(NULLIF(TRIM(s.status), ''), g.status_normalized, g.status)) AS status,
        g.product_name,
        g.chat_page
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
    let totalPcs = 0;
    for (const r of summaryRows) {
      const pcs = extractLeadingPcs(r.product_name);
      const status = r.status || 'Unknown';
      const chatPage = r.chat_page || 'Unknown';
      const product = productKey(r.product_name);
      pcsByStatus.set(status, (pcsByStatus.get(status) || 0) + pcs);
      pcsByPage.set(chatPage, (pcsByPage.get(chatPage) || 0) + pcs);
      scansByPage.set(chatPage, (scansByPage.get(chatPage) || 0) + 1);
      if (product) pcsByProduct.set(product, (pcsByProduct.get(product) || 0) + pcs);
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

    res.json({
      data,
      total,
      page: pageNum,
      per_page: perPage,
      pages: Math.ceil(total / perPage),
      summary: { by_status, by_page, by_product, total_pcs: totalPcs },
    });
  });

  r.get('/lookup/:tracking', async (req, res) => {
    const tracking = req.params.tracking.trim();
    if (!tracking) return res.status(400).json({ error: 'Tracking number required' });

    const found = await db.prepare(`
      SELECT s.tracking_no, s.customer, s.phone, s.status, s.courier, s.scan_date,
             g.product_name, g.province_city, g.cod
      FROM scan_records s
      LEFT JOIN google_orders g ON LOWER(g.tracking_no) = LOWER(s.tracking_no)
      WHERE LOWER(s.tracking_no) = LOWER(?)
      ORDER BY s.created_at DESC
      LIMIT 1
    `).get(tracking);
    if (found) return res.json(found);

    const order = await db.prepare(`
      SELECT tracking_no, customer_name AS customer, customer_phone AS phone,
             status, courier, day_created AS scan_date,
             product_name, province_city, cod
      FROM google_orders
      WHERE LOWER(tracking_no) = LOWER(?)
      LIMIT 1
    `).get(tracking);
    if (order) return res.json(order);

    return res.status(404).json({ error: 'Tracking number not found', tracking_no: tracking });
  });

  r.post('/', async (req, res) => {
    const { tracking_no, customer, phone, status, courier, scan_type, scan_date } = req.body;
    if (!tracking_no) return res.status(400).json({ error: 'Tracking number required' });
    const ref = `SCN-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO scan_records (scan_ref,tracking_no,customer,phone,scan_date,status,courier,scan_type,scanned_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(ref, tracking_no, customer||null, phone||null, scan_date||new Date().toISOString().split('T')[0], status||null, courier||null, scan_type||'Standard', req.user?.id||1);
    res.status(201).json({ scan_ref: ref });
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
