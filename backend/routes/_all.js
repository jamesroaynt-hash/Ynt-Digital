/* ─── ORDERS ──────────────────────────────────────────────── */
const express = require('express');
const googleSheetsSync = require('../services/googleSheetsSync');

function ordersRoutes(db) {
  const r = express.Router();
  const allowedStatuses = new Set(['Pending', 'Shipped', 'Delivered', 'Returned', 'Returning']);

  function cleanOrder(row = {}, index = 0) {
    return {
      order_ref: String(row.order_ref || row.id || `IMP-${Date.now()}-${index + 1}`).trim(),
      tracking_no: String(row.tracking_no || row.tracking || '').trim() || null,
      customer: String(row.customer || row.customer_name || row.name || '').trim(),
      phone: String(row.phone || row.phone_number || row.mobile || '').trim() || null,
      product: String(row.product || row.product_name || row.item || '').trim(),
      qty: Number.parseInt(row.qty || row.quantity || 1, 10) || 1,
      cod_amount: Number.parseFloat(row.cod_amount || row.cod || row.amount || row.price || 0) || 0,
      status: allowedStatuses.has(row.status) ? row.status : 'Pending',
      courier: String(row.courier || row.shipper || '').trim() || null,
      source_sheet: String(row.source_sheet || row.source || 'CSV Import').trim() || 'CSV Import',
      order_date: String(row.order_date || row.date || row.created_at || '').slice(0, 10) || new Date().toISOString().split('T')[0],
    };
  }

  async function upsertOrder(row) {
    await db.prepare(`
      INSERT INTO orders (
        order_ref, tracking_no, customer, phone, product, qty, cod_amount, status, courier, source_sheet, order_date, created_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(order_ref) DO UPDATE SET
        tracking_no = excluded.tracking_no,
        customer = excluded.customer,
        phone = excluded.phone,
        product = excluded.product,
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
      row.qty,
      row.cod_amount,
      row.status,
      row.courier,
      row.source_sheet,
      row.order_date
    );
  }

  r.get('/', async (req, res) => {
    try {
      await googleSheetsSync.ensureFreshSourceData(db);
    } catch (error) {
      console.warn(`[google_sheets] source refresh skipped: ${error.message}`);
    }

    const { status, filter, search, page=1, per_page=10, source_sheet, month, year } = req.query;
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    if (status && status !== 'All') { sql += ' AND status=?'; params.push(status); }
    if (source_sheet && source_sheet !== 'all') { sql += ' AND COALESCE(source_sheet, "")=?'; params.push(source_sheet); }
    if (month && month !== 'all') { sql += ` AND strftime('%m',order_date)=?`; params.push(String(month).padStart(2, '0')); }
    if (year && year !== 'all') { sql += ` AND strftime('%Y',order_date)=?`; params.push(String(year)); }
    if (search) { sql += ' AND (customer LIKE ? OR order_ref LIKE ? OR tracking_no LIKE ? OR courier LIKE ? OR source_sheet LIKE ?)'; const q=`%${search}%`; params.push(q,q,q,q,q); }

    if (filter === 'weekly')  { sql += ` AND order_date >= date('now','-7 days')`; }
    if (filter === 'monthly') { sql += ` AND strftime('%Y-%m',order_date)=strftime('%Y-%m','now')`; }
    if (filter === 'yearly')  { sql += ` AND strftime('%Y',order_date)=strftime('%Y','now')`; }

    const total = (await db.prepare(`SELECT COUNT(*) as c FROM orders WHERE 1=1${sql.slice(sql.indexOf('WHERE 1=1')+9)}`).get(...params)).c;
    sql += ' ORDER BY order_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));

    res.json({ data: await db.prepare(sql).all(...params), total, page: parseInt(page), per_page: parseInt(per_page) });
  });

  r.get('/stats', async (req, res) => {
    const counts = await db.prepare(`SELECT status, COUNT(*) as count, SUM(cod_amount) as total_cod FROM orders GROUP BY status`).all();
    const total_cod = (await db.prepare(`SELECT SUM(cod_amount) as total FROM orders`).get()).total || 0;
    res.json({ status_counts: counts, total_cod });
  });

  r.post('/', async (req, res) => {
    const { customer, phone, product, qty, cod_amount, status, courier, tracking_no, order_date } = req.body;
    const ref = `ORD-${Date.now()}`;
    const stmt = db.prepare(`INSERT INTO orders (order_ref,tracking_no,customer,phone,product,qty,cod_amount,status,courier,order_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const result = await stmt.run(ref, tracking_no||null, customer, phone||null, product, qty||1, cod_amount||0, status||'Pending', courier||null, order_date||new Date().toISOString().split('T')[0], req.user?.id||1);
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
    const { status, tracking_no, courier, source_sheet, order_date } = req.body;
    const next = (value) => value === undefined ? null : value;
    await db.prepare(`
      UPDATE orders
      SET status=COALESCE(?,status),
          tracking_no=COALESCE(?,tracking_no),
          courier=COALESCE(?,courier),
          source_sheet=COALESCE(?,source_sheet),
          order_date=COALESCE(?,order_date),
          updated_at=datetime('now')
      WHERE id=?
    `).run(next(status), next(tracking_no), next(courier), next(source_sheet), next(order_date), req.params.id);
    res.json({ success: true });
  });

  r.delete('/:id', async (req, res) => {
    await db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  return r;
}

/* ─── INVENTORY ───────────────────────────────────────────── */
function inventoryRoutes(db) {
  const r = express.Router();
  const allowedTypes = new Set(['Product', 'Supply']);

  function requireAdmin(req, res, next) {
    if (String(req.user?.role || '').trim() !== 'Administrator') {
      return res.status(403).json({ error: 'Administrator access required' });
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

  r.post('/', requireAdmin, async (req, res) => {
    const { name, sku, type, unit, stock, reorder_pt, cost_price, sell_price } = req.body;
    const item_id = `${type === 'Product' ? 'P' : 'S'}${String(Date.now()).slice(-4)}`;
    await db.prepare(`INSERT INTO inventory (item_id,name,sku,type,unit,stock,reorder_pt,cost_price,sell_price) VALUES (?,?,?,?,?,?,?,?,?)`).run(item_id, name, sku||null, type||'Product', unit||'pcs', stock||0, reorder_pt||(type==='Product'?200:15), cost_price||0, sell_price||null);
    res.status(201).json({ item_id });
  });

  r.post('/import', requireAdmin, async (req, res) => {
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

  r.patch('/:item_id/stock', requireAdmin, async (req, res) => {
    const { action, qty, notes } = req.body;
    const item = await db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let newStock = item.stock;
    if (action === 'add')    newStock = item.stock + qty;
    else if (action === 'remove') newStock = Math.max(0, item.stock - qty);
    else if (action === 'set')    newStock = qty;

    await db.prepare(`UPDATE inventory SET stock=?, updated_at=datetime('now') WHERE item_id=?`).run(newStock, req.params.item_id);
    await db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`).run(req.params.item_id, action, item.stock, qty, newStock, notes||null, req.user?.id||1);
    res.json({ success: true, new_stock: newStock });
  });

  return r;
}

/* ─── EXPENSES ────────────────────────────────────────────── */
function expensesRoutes(db) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { category, search, page=1, per_page=25 } = req.query;
    let sql = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];
    if (category && category !== 'All') { sql += ' AND category=?'; params.push(category); }
    if (search) { sql += ' AND (item_name LIKE ? OR noted_by LIKE ?)'; const q=`%${search}%`; params.push(q,q); }
    const total = (await db.prepare(`SELECT COUNT(*) as c ${sql.slice(sql.indexOf('FROM'))}`).get(...params)).c;
    sql += ' ORDER BY exp_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data: await db.prepare(sql).all(...params), total });
  });

  r.post('/', async (req, res) => {
    const { exp_date, category, item_name, quantity, unit_price, noted_by } = req.body;
    if (!category || !item_name || !unit_price) return res.status(400).json({ error: 'Required fields missing' });
    const ref = `EXP-${String(Date.now()).slice(-6)}`;
    await db.prepare(`INSERT INTO expenses (expense_ref,exp_date,category,item_name,quantity,unit_price,noted_by,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(ref, exp_date||new Date().toISOString().split('T')[0], category, item_name, quantity||1, unit_price, noted_by||null, req.user?.id||1);
    res.status(201).json({ expense_ref: ref });
  });

  r.delete('/:id', async (req, res) => {
    await db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
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
    const { type, page=1, per_page=25 } = req.query;
    let sql = 'SELECT * FROM scan_records WHERE 1=1';
    const params = [];
    if (type) { sql += ' AND scan_type=?'; params.push(type); }
    const total = (await db.prepare(`SELECT COUNT(*) as c ${sql.slice(sql.indexOf('FROM'))}`).get(...params)).c;
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data: await db.prepare(sql).all(...params), total });
  });

  r.get('/lookup/:tracking', async (req, res) => {
    const tracking = req.params.tracking.trim();
    // First check scan records
    let found = await db.prepare('SELECT * FROM scan_records WHERE LOWER(tracking_no)=LOWER(?) ORDER BY created_at DESC LIMIT 1').get(tracking);
    if (!found) {
      // Check orders
      const order = await db.prepare('SELECT * FROM orders WHERE LOWER(tracking_no)=LOWER(?)').get(tracking);
      if (order) {
        found = { tracking_no: order.tracking_no, customer: order.customer, phone: order.phone, status: order.status, courier: order.courier, scan_date: order.order_date };
      }
    }
    if (!found) return res.status(404).json({ error: 'Tracking number not found', tracking_no: tracking });
    res.json(found);
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

module.exports = ordersRoutes;
module.exports.ordersRoutes    = ordersRoutes;
module.exports.inventoryRoutes = inventoryRoutes;
module.exports.expensesRoutes  = expensesRoutes;
module.exports.pickupsRoutes   = pickupsRoutes;
module.exports.scansRoutes     = scansRoutes;
