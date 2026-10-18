const express = require('express');

// Stock flow: the daily cycle that keeps inventory honest.
//
//   Stock In    supplies counted on arrival, the actual quantity added
//   Picking     the day's confirmed POS orders totalled per item, page detail
//               kept. Building it never touches stock.
//   Stock Out   the quantity that actually left, posted once per day. The
//               picking list is only the plan; a short or cancelled pack is a
//               difference with a reason, not a silent over-deduction.
//   Returns     an RTS scan only says a parcel came back. Stock goes up when
//               someone opens it and counts what can be sold again.
//   Count       a physical count adjusts stock to what is on the shelf, and
//               the variance is kept.
//
// Every change is written to inventory_logs with a movement and a ref, which
// is what the balance report splits a day by. Reading is open to any signed-in
// account; writing is the same gate as the Inventory page (Administrator,
// Logistics) plus the super admin.
const WRITE_ROLES = new Set(['administrator', 'logistics']);
const CANCELED = ['canceled', 'removed'];
const MOVEMENT_GROUP = {
  stock_in: 'in',
  stock_out: 'out',
  stock_out_void: 'out',
  return: 'returns',
  count: 'adjust',
  rts_fold: 'adjust',
};

function int(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function text(value, max = 500) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function manilaToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// A Manila day as a UTC range, in the 'YYYY-MM-DD HH:MM:SS' form both the
// POS timestamps ('T' separated) and the log timestamps compare against.
function manilaDayStartUtc(day) {
  return `${addDays(day, -1)} 16:00:00`;
}

function manilaDayOf(value) {
  if (!value) return null;
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

// Same key the Inventory page matches RTS products to items by.
function productKey(name) {
  return String(name || '').replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function leadingPcs(name) {
  const m = String(name || '').match(/^\s*(\d+)/);
  return m ? Math.min(10000, parseInt(m[1], 10)) : 1;
}

// Pcs in an order, the rule the RTS scan pages use: each line is the bundle
// number at the start of its variation name ("2 BOTTLE ..." → 2, none → 1)
// times its quantity, summed in SQL so the line items never leave the
// database. An order with no line items falls back to the product name.
function itemPcsExpr(db, alias = 'p') {
  return db.type === 'postgres'
    ? `(SELECT SUM(
          LEAST(10000, COALESCE(NULLIF(substring(COALESCE(e->'variation_info'->>'name', e->>'name', '') from '^\\s*(\\d+)'), '')::int, 1))
          * GREATEST(1, COALESCE(NULLIF(e->>'quantity', '')::numeric, 1)))
        FROM jsonb_array_elements(CASE WHEN ${alias}.items_json LIKE '[%' THEN ${alias}.items_json::jsonb ELSE '[]'::jsonb END) e)`
    : `(SELECT SUM(
          MIN(10000, MAX(1, COALESCE(CAST(TRIM(COALESCE(json_extract(e.value, '$.variation_info.name'), json_extract(e.value, '$.name'), '')) AS INTEGER), 1)))
          * MAX(1, COALESCE(CAST(json_extract(e.value, '$.quantity') AS REAL), 1)))
        FROM json_each(CASE WHEN json_valid(${alias}.items_json) AND ${alias}.items_json LIKE '[%' THEN ${alias}.items_json ELSE '[]' END) e)`;
}

function rowPcs(row) {
  const n = Number(row.item_pcs);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : leadingPcs(row.note_product);
}

module.exports = function stockFlowRoutes(db, { dispatch } = {}) {
  const r = express.Router();

  // Signed-in staff only; API keys have no stock-flow scope.
  r.use((req, res, next) => (req.user?.role === 'api_key'
    ? res.status(403).json({ error: 'Not available to API keys' })
    : next()));

  async function currentUser(req) {
    if (!req.user?.id) return req.user || null;
    const row = await db.prepare('SELECT id, full_name, role, is_super_admin FROM users WHERE id = ?').get(req.user.id);
    return row || req.user;
  }

  async function requireWrite(req, res, next) {
    try {
      const user = await currentUser(req);
      const role = String(user?.role || '').trim().toLowerCase();
      if (!WRITE_ROLES.has(role) && Number(user?.is_super_admin) !== 1) {
        return res.status(403).json({ error: 'Administrator or Logistics access required' });
      }
      req.stockUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function getSetting(key) {
    const row = await db.prepare('SELECT value FROM stock_flow_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  async function setSetting(key, value) {
    await db.prepare(`
      INSERT INTO stock_flow_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value === null ? null : String(value));
  }

  async function returnsStartScanId() {
    const value = await getSetting('returns_start_scan_id');
    return value === null ? null : int(value, 0);
  }

  // Adds delta to an item's stock and logs it. The increment happens in SQL so
  // two writers can't both read the old number; before is derived from after.
  // qty_change keeps the log's existing convention: positive for add/remove,
  // signed for an adjustment.
  async function applyMovement(itemId, delta, { movement, ref, notes, userId }) {
    await db.prepare("UPDATE inventory SET stock = stock + ?, updated_at = datetime('now') WHERE item_id = ?").run(delta, itemId);
    const row = await db.prepare('SELECT stock, name FROM inventory WHERE item_id = ?').get(itemId);
    const after = Number(row?.stock || 0);
    const before = after - delta;
    const action = movement === 'stock_in' ? 'add' : movement === 'stock_out' ? 'remove' : 'adjustment';
    const change = action === 'adjustment' ? delta : Math.abs(delta);
    await db.prepare(`
      INSERT INTO inventory_logs (item_id, action, qty_before, qty_change, qty_after, notes, created_by, movement, ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, action, before, change, after, notes || null, userId || null, movement, ref || null);
    if (dispatch) dispatch('inventory.updated', { item_id: itemId, name: row?.name, action, movement, qty_before: before, qty_after: after });
    return { before, after };
  }

  async function inventoryItems() {
    return db.prepare('SELECT item_id, name, sku, type, unit, stock, reorder_pt, active FROM inventory ORDER BY name').all();
  }

  // page → inventory item, through the page→SKU map the RTS Return tab keeps.
  async function pageItemMap(items) {
    const bySku = new Map(items.filter((i) => i.sku).map((i) => [String(i.sku).trim(), i]));
    const rows = await db.prepare('SELECT page_name, sku FROM rts_page_sku').all();
    const map = new Map();
    for (const row of rows) {
      const item = bySku.get(String(row.sku || '').trim());
      if (item) map.set(row.page_name, item);
    }
    return map;
  }

  /* ── Picking list ─────────────────────────────────────────── */

  // Orders confirmed on a Manila day, minus anything since cancelled, totalled
  // per inventory item with each page's share kept for the printout.
  async function buildPicking(day) {
    const rows = await db.prepare(`
      SELECT p.page_name, p.note_product, ${itemPcsExpr(db)} AS item_pcs
      FROM pos_orders p
      WHERE confirmed_at >= ? AND confirmed_at < ?
        AND COALESCE(p.status_name, '') NOT IN (${CANCELED.map(() => '?').join(',')})
    `).all(manilaDayStartUtc(day).replace(' ', 'T'), manilaDayStartUtc(addDays(day, 1)).replace(' ', 'T'), ...CANCELED);

    const items = await inventoryItems();
    const pageMap = await pageItemMap(items);
    const byItem = new Map();
    const unmapped = new Map();
    let pcs = 0;
    for (const row of rows) {
      const page = row.page_name || 'Unknown page';
      const n = rowPcs(row);
      pcs += n;
      const item = pageMap.get(page);
      const bucket = item
        ? (byItem.get(item.item_id) || byItem.set(item.item_id, { item, orders: 0, pcs: 0, pages: new Map() }).get(item.item_id))
        : (unmapped.get(page) || unmapped.set(page, { page, orders: 0, pcs: 0 }).get(page));
      bucket.orders += 1;
      bucket.pcs += n;
      if (item) {
        const p = bucket.pages.get(page) || { page, orders: 0, pcs: 0 };
        p.orders += 1;
        p.pcs += n;
        bucket.pages.set(page, p);
      }
    }
    return {
      date: day,
      orders: rows.length,
      pcs,
      items: [...byItem.values()].map(({ item, orders, pcs: planned, pages }) => ({
        item_id: item.item_id,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        stock: Number(item.stock || 0),
        orders,
        planned,
        pages: [...pages.values()].sort((a, b) => b.pcs - a.pcs),
      })).sort((a, b) => b.planned - a.planned),
      unmapped: [...unmapped.values()].sort((a, b) => b.pcs - a.pcs),
    };
  }

  async function batchFor(day) {
    const batch = await db.prepare('SELECT * FROM stock_out_batches WHERE out_date = ?').get(day);
    if (!batch) return null;
    const lines = await db.prepare(`
      SELECT l.item_id, l.planned_qty, l.packed_qty, l.reason, l.pages_json, i.name, i.sku, i.unit
      FROM stock_out_lines l LEFT JOIN inventory i ON i.item_id = l.item_id
      WHERE l.batch_id = ? ORDER BY l.id
    `).all(batch.id);
    const users = await db.prepare('SELECT id, full_name FROM users WHERE id IN (?, ?)').all(batch.posted_by || 0, batch.voided_by || 0);
    const name = (id) => users.find((u) => Number(u.id) === Number(id))?.full_name || null;
    let unmappedPages = [];
    try { unmappedPages = JSON.parse(batch.unmapped_json || '[]'); } catch { unmappedPages = []; }
    return {
      ...batch,
      unmapped: unmappedPages,
      posted_by_name: name(batch.posted_by),
      voided_by_name: name(batch.voided_by),
      lines: lines.map((l) => {
        let pages = [];
        try { pages = JSON.parse(l.pages_json || '[]'); } catch { pages = []; }
        return { ...l, pages, pages_json: undefined, variance: Number(l.packed_qty) - Number(l.planned_qty) };
      }),
    };
  }

  r.get('/picking', wrap(async (req, res) => {
    const day = isDate(req.query.date) ? req.query.date : addDays(manilaToday(), -1);
    const picking = await buildPicking(day);
    res.json({ ...picking, batch: await batchFor(day) });
  }));

  // Link a page to an inventory item from the picking list. Same map as the
  // RTS Return tab, so one link serves both the stock out and the returns.
  r.put('/page-item', requireWrite, wrap(async (req, res) => {
    const page = text(req.body?.page_name, 200);
    if (!page) return res.status(400).json({ error: 'page_name required' });
    const itemId = text(req.body?.item_id, 64);
    if (!itemId) {
      await db.prepare('DELETE FROM rts_page_sku WHERE page_name = ?').run(page);
      return res.json({ success: true, page_name: page, sku: '' });
    }
    const item = await db.prepare('SELECT sku FROM inventory WHERE item_id = ?').get(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.sku) return res.status(400).json({ error: 'Give this item a SKU first — pages are linked by SKU.' });
    await db.prepare(`
      INSERT INTO rts_page_sku (page_name, sku, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(page_name) DO UPDATE SET sku = excluded.sku, updated_at = datetime('now')
    `).run(page, item.sku);
    res.json({ success: true, page_name: page, sku: item.sku });
  }));

  /* ── Stock out ────────────────────────────────────────────── */

  r.get('/stock-out', wrap(async (req, res) => {
    const limit = Math.min(90, Math.max(1, int(req.query.limit, 30)));
    const rows = await db.prepare('SELECT out_date FROM stock_out_batches ORDER BY out_date DESC LIMIT ?').all(limit);
    const batches = [];
    for (const row of rows) batches.push(await batchFor(row.out_date));
    res.json({ batches });
  }));

  r.post('/stock-out', requireWrite, wrap(async (req, res) => {
    const day = req.body?.date;
    if (!isDate(day)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
    const existing = await db.prepare('SELECT id, status FROM stock_out_batches WHERE out_date = ?').get(day);
    if (existing && existing.status === 'posted') {
      return res.status(409).json({ error: `Stock out for ${day} is already posted. Void it first to post again.` });
    }

    // The plan is rebuilt here rather than trusted from the browser.
    const picking = await buildPicking(day);
    const planned = new Map(picking.items.map((i) => [i.item_id, i]));
    const stockById = new Map((await inventoryItems()).map((i) => [i.item_id, i]));

    const incoming = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const lines = [];
    const seen = new Set();
    for (const raw of incoming) {
      const itemId = text(raw?.item_id, 64);
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      const item = stockById.get(itemId);
      if (!item) return res.status(400).json({ error: `Unknown item ${itemId}` });
      const packed = int(raw.packed_qty, -1);
      if (packed < 0) return res.status(400).json({ error: `Packed quantity for ${item.name} must be 0 or more` });
      const plan = planned.get(itemId);
      const plannedQty = plan ? plan.planned : 0;
      const reason = text(raw.reason, 300);
      if (packed !== plannedQty && !reason) {
        return res.status(400).json({ error: `${item.name}: packed ${packed} but the picking list says ${plannedQty}. Give a reason for the difference.` });
      }
      lines.push({ item, packed, plannedQty, reason, pages: plan ? plan.pages : [] });
    }
    // Anything on the picking list the browser left out was not packed.
    for (const plan of picking.items) {
      if (!seen.has(plan.item_id) && plan.planned > 0) {
        return res.status(400).json({ error: `${plan.name} is on the picking list — enter what was packed (0 if nothing).` });
      }
    }
    if (!lines.some((l) => l.packed > 0)) return res.status(400).json({ error: 'Nothing packed to post' });
    if (picking.unmapped.length && !req.body?.acknowledge_unmapped) {
      return res.status(409).json({
        error: 'Some pages are not linked to an item, so their pcs would not be deducted.',
        unmapped: picking.unmapped,
      });
    }
    const short = lines
      .filter((l) => l.packed > Number(l.item.stock || 0))
      .map((l) => ({ item_id: l.item.item_id, name: l.item.name, stock: Number(l.item.stock || 0), packed: l.packed }));
    if (short.length) {
      return res.status(409).json({
        error: 'Packed more than the system has in stock. Record the stock in or do a count first.',
        short,
      });
    }

    const user = req.stockUser;
    const totals = {
      planned: lines.reduce((s, l) => s + l.plannedQty, 0),
      packed: lines.reduce((s, l) => s + l.packed, 0),
    };
    const unmappedJson = JSON.stringify(picking.unmapped);
    let batchId;
    if (existing) {
      // Re-posting a voided day. The status condition makes a second click lose.
      const updated = await db.prepare(`
        UPDATE stock_out_batches SET status = 'posted', orders = ?, planned_pcs = ?, packed_pcs = ?,
          unmapped_json = ?, notes = ?, posted_by = ?, posted_at = datetime('now'),
          voided_by = NULL, voided_at = NULL, void_reason = NULL
        WHERE id = ? AND status = 'voided'
      `).run(picking.orders, totals.planned, totals.packed, unmappedJson, text(req.body?.notes), user?.id || null, existing.id);
      if (!updated.changes) return res.status(409).json({ error: `Stock out for ${day} was just posted by someone else.` });
      await db.prepare('DELETE FROM stock_out_lines WHERE batch_id = ?').run(existing.id);
      batchId = existing.id;
    } else {
      try {
        const inserted = await db.prepare(`
          INSERT INTO stock_out_batches (out_date, status, orders, planned_pcs, packed_pcs, unmapped_json, notes, posted_by)
          VALUES (?, 'posted', ?, ?, ?, ?, ?, ?)
        `).run(day, picking.orders, totals.planned, totals.packed, unmappedJson, text(req.body?.notes), user?.id || null);
        batchId = Number(inserted.lastInsertRowid);
      } catch {
        return res.status(409).json({ error: `Stock out for ${day} was just posted by someone else.` });
      }
      if (!batchId) batchId = (await db.prepare('SELECT id FROM stock_out_batches WHERE out_date = ?').get(day)).id;
    }

    for (const line of lines) {
      await db.prepare(`
        INSERT INTO stock_out_lines (batch_id, item_id, planned_qty, packed_qty, reason, pages_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(batchId, line.item.item_id, line.plannedQty, line.packed, line.reason, JSON.stringify(line.pages));
      if (line.packed > 0) {
        const note = line.packed === line.plannedQty
          ? `Stock out ${day}`
          : `Stock out ${day} — planned ${line.plannedQty}, packed ${line.packed}: ${line.reason}`;
        await applyMovement(line.item.item_id, -line.packed, { movement: 'stock_out', ref: `OUT-${day}`, notes: note, userId: user?.id });
      }
    }
    res.status(201).json({ batch: await batchFor(day) });
  }));

  r.post('/stock-out/:date/void', requireWrite, wrap(async (req, res) => {
    const day = req.params.date;
    const reason = text(req.body?.reason, 300);
    if (!reason) return res.status(400).json({ error: 'A reason is required to void a stock out' });
    const batch = await db.prepare('SELECT id FROM stock_out_batches WHERE out_date = ?').get(day);
    if (!batch) return res.status(404).json({ error: 'No stock out for that day' });
    const user = req.stockUser;
    const updated = await db.prepare(`
      UPDATE stock_out_batches SET status = 'voided', voided_by = ?, voided_at = datetime('now'), void_reason = ?
      WHERE id = ? AND status = 'posted'
    `).run(user?.id || null, reason, batch.id);
    if (!updated.changes) return res.status(409).json({ error: 'That stock out is already voided' });
    const lines = await db.prepare('SELECT item_id, packed_qty FROM stock_out_lines WHERE batch_id = ?').all(batch.id);
    for (const line of lines) {
      if (Number(line.packed_qty) > 0) {
        await applyMovement(line.item_id, Number(line.packed_qty), {
          movement: 'stock_out_void', ref: `OUT-${day}`, notes: `Voided stock out ${day}: ${reason}`, userId: user?.id,
        });
      }
    }
    res.json({ batch: await batchFor(day) });
  }));

  /* ── Stock in ─────────────────────────────────────────────── */

  r.post('/stock-in', requireWrite, wrap(async (req, res) => {
    const item = await db.prepare('SELECT item_id, name FROM inventory WHERE item_id = ?').get(text(req.body?.item_id, 64));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const qty = int(req.body?.qty, 0);
    if (qty <= 0) return res.status(400).json({ error: 'Quantity received must be more than 0' });
    const supplier = text(req.body?.supplier, 120);
    const ref = text(req.body?.ref, 80);
    const day = isDate(req.body?.received_date) ? req.body.received_date : manilaToday();
    const note = [`Received ${day}`, supplier && `from ${supplier}`, text(req.body?.notes, 300)].filter(Boolean).join(' · ');
    const result = await applyMovement(item.item_id, qty, {
      movement: 'stock_in', ref: ref ? `IN ${ref}` : `IN-${day}`, notes: note, userId: req.stockUser?.id,
    });
    res.status(201).json({ success: true, item_id: item.item_id, ...result });
  }));

  /* ── Returns ──────────────────────────────────────────────── */

  // RTS scans the switch-over left behind: the Inventory page has been adding
  // them to Total Stock unopened. Folding them into stock once keeps Total
  // Stock where it was; from then on a return only counts after inspection.
  async function legacyRtsByItem(maxScanId) {
    const items = await inventoryItems();
    const pageMap = await pageItemMap(items);
    const byName = new Map(items.map((i) => [productKey(i.name), i]));
    const rows = await db.prepare(`
      SELECT s.id, p.page_name, p.note_product, ${itemPcsExpr(db)} AS item_pcs
      FROM scan_records s
      LEFT JOIN pos_orders p ON LOWER(p.tracking_no) = LOWER(s.tracking_no)
      WHERE s.scan_type = 'RTS' AND s.id <= ?
    `).all(maxScanId);
    const totals = new Map();
    for (const row of rows) {
      const page = row.page_name || 'Unknown';
      const item = pageMap.get(page) || byName.get(productKey(row.note_product));
      if (!item) continue;
      totals.set(item.item_id, (totals.get(item.item_id) || 0) + rowPcs(row));
    }
    return items
      .filter((i) => totals.get(i.item_id))
      .map((i) => ({ item_id: i.item_id, name: i.name, sku: i.sku, stock: Number(i.stock || 0), rts_pcs: totals.get(i.item_id) }));
  }

  async function maxRtsScanId() {
    const row = await db.prepare("SELECT MAX(id) AS id FROM scan_records WHERE scan_type = 'RTS'").get();
    return int(row?.id, 0);
  }

  r.get('/returns/start-preview', wrap(async (req, res) => {
    const start = await returnsStartScanId();
    if (start !== null) return res.json({ started: true, start_scan_id: start });
    const maxId = await maxRtsScanId();
    res.json({ started: false, max_scan_id: maxId, items: await legacyRtsByItem(maxId) });
  }));

  r.post('/returns/start', requireWrite, wrap(async (req, res) => {
    if ((await returnsStartScanId()) !== null) return res.status(409).json({ error: 'Inspected returns are already on' });
    const maxId = await maxRtsScanId();
    // Claim the switch first so a double click can't fold the pcs twice.
    try {
      await db.prepare("INSERT INTO stock_flow_settings (key, value) VALUES ('returns_start_scan_id', ?)").run(String(maxId));
    } catch {
      return res.status(409).json({ error: 'Inspected returns are already on' });
    }
    const fold = req.body?.fold !== false;
    const items = fold ? await legacyRtsByItem(maxId) : [];
    for (const item of items) {
      await applyMovement(item.item_id, item.rts_pcs, {
        movement: 'rts_fold', ref: 'RTS-SWITCH', notes: `RTS pcs scanned before inspected returns (scans up to #${maxId})`, userId: req.stockUser?.id,
      });
    }
    await setSetting('returns_started_at', new Date().toISOString());
    res.status(201).json({ started: true, start_scan_id: maxId, folded: items });
  }));

  // Parcels scanned back since the switch, one row per tracking number.
  async function returnRows(start) {
    const rows = await db.prepare(`
      SELECT s.id, s.tracking_no, s.scan_date, s.customer, s.courier,
             p.page_name, p.note_product, ${itemPcsExpr(db)} AS item_pcs,
             i.status AS inspection_status, i.item_id AS inspected_item_id, i.expected_pcs, i.sellable_qty,
             i.damaged_qty, i.notes AS inspection_notes, i.inspected_at, u.full_name AS inspected_by_name
      FROM scan_records s
      LEFT JOIN pos_orders p ON LOWER(p.tracking_no) = LOWER(s.tracking_no)
      LEFT JOIN return_inspections i ON i.tracking_key = LOWER(s.tracking_no)
      LEFT JOIN users u ON u.id = i.inspected_by
      WHERE s.scan_type = 'RTS' AND s.id > ?
      ORDER BY s.id DESC
    `).all(start);
    const items = await inventoryItems();
    const pageMap = await pageItemMap(items);
    const byName = new Map(items.map((i) => [productKey(i.name), i]));
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const key = String(row.tracking_no || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const suggested = pageMap.get(row.page_name) || byName.get(productKey(row.note_product)) || null;
      out.push({
        scan_id: row.id,
        tracking_no: row.tracking_no,
        scan_date: row.scan_date,
        customer: row.customer,
        courier: row.courier,
        page: row.page_name || null,
        product: row.note_product || null,
        expected_pcs: row.inspection_status ? Number(row.expected_pcs || 0) : rowPcs(row),
        suggested_item_id: suggested?.item_id || null,
        inspection: row.inspection_status ? {
          status: row.inspection_status,
          item_id: row.inspected_item_id,
          sellable_qty: Number(row.sellable_qty || 0),
          damaged_qty: Number(row.damaged_qty || 0),
          notes: row.inspection_notes,
          inspected_at: row.inspected_at,
          inspected_by_name: row.inspected_by_name,
        } : null,
      });
    }
    return out;
  }

  // What the Inventory page needs to stop adding raw RTS scans to Total Stock
  // once inspected returns are on, and to show what is waiting to be opened.
  r.get('/status', wrap(async (req, res) => {
    const start = await returnsStartScanId();
    if (start === null) return res.json({ returns_started: false });
    const pending = (await returnRows(start)).filter((row) => !row.inspection);
    const pendingByItem = {};
    for (const row of pending) {
      if (row.suggested_item_id) pendingByItem[row.suggested_item_id] = (pendingByItem[row.suggested_item_id] || 0) + row.expected_pcs;
    }
    res.json({ returns_started: true, pending_count: pending.length, pending_by_item: pendingByItem });
  }));

  r.get('/returns', wrap(async (req, res) => {
    const start = await returnsStartScanId();
    if (start === null) return res.json({ started: false, rows: [] });
    const rows = await returnRows(start);
    const pending = rows.filter((r) => !r.inspection);
    const pendingByItem = {};
    for (const row of pending) {
      if (row.suggested_item_id) pendingByItem[row.suggested_item_id] = (pendingByItem[row.suggested_item_id] || 0) + row.expected_pcs;
    }
    res.json({
      started: true,
      start_scan_id: start,
      pending_count: pending.length,
      pending_pcs: pending.reduce((s, r) => s + r.expected_pcs, 0),
      pending_by_item: pendingByItem,
      rows: req.query.status === 'pending' ? pending : rows.slice(0, Math.min(1000, Math.max(1, int(req.query.limit, 500)))),
    });
  }));

  r.post('/returns/inspect', requireWrite, wrap(async (req, res) => {
    const start = await returnsStartScanId();
    if (start === null) return res.status(400).json({ error: 'Turn on inspected returns first' });
    const tracking = text(req.body?.tracking_no, 80);
    if (!tracking) return res.status(400).json({ error: 'tracking_no required' });
    const scan = await db.prepare(`
      SELECT id FROM scan_records WHERE scan_type = 'RTS' AND LOWER(tracking_no) = LOWER(?) AND id > ?
      ORDER BY id DESC LIMIT 1
    `).get(tracking, start);
    if (!scan) return res.status(404).json({ error: 'No RTS scan for that tracking number since inspected returns started' });
    const sellable = int(req.body?.sellable_qty, -1);
    const damaged = int(req.body?.damaged_qty, -1);
    if (sellable < 0 || damaged < 0) return res.status(400).json({ error: 'Sellable and damaged must be 0 or more' });
    const itemId = text(req.body?.item_id, 64);
    const item = itemId ? await db.prepare('SELECT item_id FROM inventory WHERE item_id = ?').get(itemId) : null;
    if (sellable > 0 && !item) return res.status(400).json({ error: 'Pick the item the sellable pcs go back into' });
    const notes = text(req.body?.notes, 300);
    const status = sellable > 0 ? 'restocked' : damaged > 0 ? 'damaged' : 'missing';
    if (status === 'missing' && !notes) return res.status(400).json({ error: 'Nothing sellable or damaged — note what was in the parcel' });

    try {
      await db.prepare(`
        INSERT INTO return_inspections (tracking_key, scan_id, item_id, expected_pcs, sellable_qty, damaged_qty, status, notes, inspected_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tracking.toLowerCase(), scan.id, item?.item_id || null, Math.max(0, int(req.body?.expected_pcs, 0)),
        sellable, damaged, status, notes, req.stockUser?.id || null);
    } catch {
      return res.status(409).json({ error: 'That parcel is already inspected' });
    }
    if (sellable > 0) {
      const note = [`Return ${tracking}`, damaged ? `${damaged} damaged` : null, notes].filter(Boolean).join(' · ');
      await applyMovement(item.item_id, sellable, { movement: 'return', ref: `RTS ${tracking}`, notes: note, userId: req.stockUser?.id });
    }
    res.status(201).json({ success: true, status });
  }));

  /* ── Physical count ───────────────────────────────────────── */

  r.post('/counts', requireWrite, wrap(async (req, res) => {
    // Until the switch, Total Stock on the Inventory page still adds every RTS
    // scan on top of stock, so a shelf count could not be compared to anything.
    if ((await returnsStartScanId()) === null) {
      return res.status(409).json({ error: 'Turn on inspected returns (Returns tab) before the first count.' });
    }
    const day = isDate(req.body?.date) ? req.body.date : manilaToday();
    const incoming = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const stockById = new Map((await inventoryItems()).map((i) => [i.item_id, i]));
    const lines = [];
    for (const raw of incoming) {
      const item = stockById.get(text(raw?.item_id, 64));
      if (!item) continue;
      if (raw.counted_qty === '' || raw.counted_qty === null || raw.counted_qty === undefined) continue;
      const counted = int(raw.counted_qty, -1);
      if (counted < 0) return res.status(400).json({ error: `Counted quantity for ${item.name} must be 0 or more` });
      const expected = Number(item.stock || 0);
      const variance = counted - expected;
      const reason = text(raw.reason, 300);
      if (variance !== 0 && !reason) {
        return res.status(400).json({ error: `${item.name}: counted ${counted}, system has ${expected}. Give a reason for the difference.` });
      }
      lines.push({ item, counted, expected, variance, reason });
    }
    if (!lines.length) return res.status(400).json({ error: 'Enter at least one counted quantity' });

    const user = req.stockUser;
    for (const line of lines) {
      await db.prepare(`
        INSERT INTO stock_counts (count_date, item_id, expected_qty, counted_qty, variance, reason, counted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(day, line.item.item_id, line.expected, line.counted, line.variance, line.reason, user?.id || null);
      if (line.variance !== 0) {
        await applyMovement(line.item.item_id, line.variance, {
          movement: 'count', ref: `COUNT-${day}`, notes: `Count ${day}: system ${line.expected}, shelf ${line.counted} — ${line.reason}`, userId: user?.id,
        });
      }
    }
    res.status(201).json({
      counted: lines.length,
      adjusted: lines.filter((l) => l.variance !== 0).length,
      lines: lines.map((l) => ({ item_id: l.item.item_id, name: l.item.name, expected: l.expected, counted: l.counted, variance: l.variance })),
    });
  }));

  r.get('/counts', wrap(async (req, res) => {
    const limit = Math.min(500, Math.max(1, int(req.query.limit, 200)));
    const rows = await db.prepare(`
      SELECT c.*, i.name, i.sku, u.full_name AS counted_by_name
      FROM stock_counts c
      LEFT JOIN inventory i ON i.item_id = c.item_id
      LEFT JOIN users u ON u.id = c.counted_by
      ORDER BY c.id DESC LIMIT ?
    `).all(limit);
    res.json({ counts: rows });
  }));

  /* ── Balance report and overview ──────────────────────────── */

  // Logs from a Manila day onwards, each with its Manila day and signed change.
  async function logsSince(day) {
    const rows = await db.prepare(`
      SELECT item_id, qty_before, qty_after, movement, created_at
      FROM inventory_logs WHERE created_at >= ?
    `).all(manilaDayStartUtc(day));
    return rows.map((row) => ({
      item_id: row.item_id,
      change: Number(row.qty_after || 0) - Number(row.qty_before || 0),
      group: MOVEMENT_GROUP[row.movement] || 'manual',
      day: manilaDayOf(row.created_at),
    }));
  }

  // Per item: opening, in, out, returns, adjustments, manual edits and the
  // closing balance for a range. Walked back from today's stock, so the
  // closing is always what the system holds at the end of the range.
  async function balance(from, to) {
    const items = await inventoryItems();
    const logs = await logsSince(from);
    const rows = items.map((item) => {
      const mine = logs.filter((l) => l.item_id === item.item_id);
      const after = mine.filter((l) => l.day > to).reduce((s, l) => s + l.change, 0);
      const inRange = mine.filter((l) => l.day >= from && l.day <= to);
      const sum = (group) => inRange.filter((l) => l.group === group).reduce((s, l) => s + l.change, 0);
      const closing = Number(item.stock || 0) - after;
      const moved = inRange.reduce((s, l) => s + l.change, 0);
      return {
        item_id: item.item_id,
        sku: item.sku,
        name: item.name,
        type: item.type,
        unit: item.unit,
        active: item.active,
        opening: closing - moved,
        stock_in: sum('in'),
        stock_out: -sum('out'),
        returns: sum('returns'),
        adjustments: sum('adjust'),
        manual: sum('manual'),
        closing,
      };
    });
    return rows;
  }

  r.get('/balance', wrap(async (req, res) => {
    const to = isDate(req.query.to) ? req.query.to : manilaToday();
    const from = isDate(req.query.from) && req.query.from <= to ? req.query.from : to;
    res.json({ from, to, rows: await balance(from, to) });
  }));

  r.get('/overview', wrap(async (req, res) => {
    const today = manilaToday();
    const yesterday = addDays(today, -1);
    const items = (await inventoryItems()).filter((i) => Number(i.active) !== 0);

    const picking = await buildPicking(yesterday);
    const outYesterday = await db.prepare('SELECT status, packed_pcs, posted_at FROM stock_out_batches WHERE out_date = ?').get(yesterday);

    // Average daily stock out over the last 14 days, from posted stock outs.
    const since = addDays(today, -14);
    const outLines = await db.prepare(`
      SELECT l.item_id, l.packed_qty FROM stock_out_lines l
      JOIN stock_out_batches b ON b.id = l.batch_id
      WHERE b.status = 'posted' AND b.out_date >= ? AND b.out_date < ?
    `).all(since, today);
    const outByItem = new Map();
    for (const l of outLines) outByItem.set(l.item_id, (outByItem.get(l.item_id) || 0) + Number(l.packed_qty || 0));

    const lastCounts = await db.prepare('SELECT item_id, MAX(count_date) AS last FROM stock_counts GROUP BY item_id').all();
    const lastCount = new Map(lastCounts.map((c) => [c.item_id, c.last]));

    const start = await returnsStartScanId();
    let returns = { started: false };
    if (start !== null) {
      const rows = await returnRows(start);
      const pending = rows.filter((row) => !row.inspection);
      returns = {
        started: true,
        pending_count: pending.length,
        pending_pcs: pending.reduce((s, row) => s + row.expected_pcs, 0),
        oldest_pending: pending.length ? pending[pending.length - 1].scan_date : null,
      };
    }

    const stock = items.map((item) => {
      const avgOut = (outByItem.get(item.item_id) || 0) / 14;
      const onHand = Number(item.stock || 0);
      const last = lastCount.get(item.item_id) || null;
      return {
        item_id: item.item_id,
        name: item.name,
        sku: item.sku,
        type: item.type,
        unit: item.unit,
        stock: onHand,
        reorder_pt: Number(item.reorder_pt || 0),
        low: onHand < Number(item.reorder_pt || 0),
        avg_daily_out: Math.round(avgOut * 10) / 10,
        days_cover: avgOut > 0 ? Math.floor(onHand / avgOut) : null,
        last_counted: last,
        days_since_count: last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : null,
      };
    });

    res.json({
      today,
      picking: { date: yesterday, orders: picking.orders, pcs: picking.pcs, items: picking.items.length, unmapped: picking.unmapped },
      stock_out: outYesterday ? { date: yesterday, status: outYesterday.status, packed_pcs: outYesterday.packed_pcs } : { date: yesterday, status: 'not_posted' },
      returns,
      stock,
    });
  }));

  return r;
};

