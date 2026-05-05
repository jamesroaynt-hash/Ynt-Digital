/* ─── ORDERS ──────────────────────────────────────────────── */
const express = require('express');

function ordersRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const { status, filter, search, page=1, per_page=10 } = req.query;
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];

    if (status && status !== 'All') { sql += ' AND status=?'; params.push(status); }
    if (search) { sql += ' AND (customer LIKE ? OR order_ref LIKE ? OR tracking_no LIKE ?)'; const q=`%${search}%`; params.push(q,q,q); }

    if (filter === 'weekly')  { sql += ` AND order_date >= date('now','-7 days')`; }
    if (filter === 'monthly') { sql += ` AND strftime('%Y-%m',order_date)=strftime('%Y-%m','now')`; }
    if (filter === 'yearly')  { sql += ` AND strftime('%Y',order_date)=strftime('%Y','now')`; }

    const total = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE 1=1${sql.slice(sql.indexOf('WHERE 1=1')+9)}`).get(...params).c;
    sql += ' ORDER BY order_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));

    res.json({ data: db.prepare(sql).all(...params), total, page: parseInt(page), per_page: parseInt(per_page) });
  });

  r.get('/stats', (req, res) => {
    const counts = db.prepare(`SELECT status, COUNT(*) as count, SUM(cod_amount) as total_cod FROM orders GROUP BY status`).all();
    const total_cod = db.prepare(`SELECT SUM(cod_amount) as total FROM orders`).get().total || 0;
    res.json({ status_counts: counts, total_cod });
  });

  r.post('/', (req, res) => {
    const { customer, phone, product, qty, cod_amount, status, courier, tracking_no, order_date } = req.body;
    const ref = `ORD-${Date.now()}`;
    const stmt = db.prepare(`INSERT INTO orders (order_ref,tracking_no,customer,phone,product,qty,cod_amount,status,courier,order_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const result = stmt.run(ref, tracking_no||null, customer, phone||null, product, qty||1, cod_amount||0, status||'Pending', courier||null, order_date||new Date().toISOString().split('T')[0], req.user?.id||1);
    res.status(201).json({ id: result.lastInsertRowid, order_ref: ref });
  });

  r.put('/:id', (req, res) => {
    const { status, tracking_no, courier } = req.body;
    db.prepare(`UPDATE orders SET status=COALESCE(?,status), tracking_no=COALESCE(?,tracking_no), courier=COALESCE(?,courier), updated_at=datetime('now') WHERE id=?`).run(status||null, tracking_no||null, courier||null, req.params.id);
    res.json({ success: true });
  });

  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  return r;
}

/* ─── INVENTORY ───────────────────────────────────────────── */
function inventoryRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const { type } = req.query;
    let sql = 'SELECT * FROM inventory';
    const params = [];
    if (type) { sql += ' WHERE type=?'; params.push(type); }
    res.json(db.prepare(sql).all(...params));
  });

  r.get('/low-stock', (req, res) => {
    res.json(db.prepare('SELECT * FROM inventory WHERE stock < reorder_pt').all());
  });

  r.post('/', (req, res) => {
    const { name, sku, type, unit, stock, reorder_pt, cost_price, sell_price } = req.body;
    const item_id = `${type === 'Product' ? 'P' : 'S'}${String(Date.now()).slice(-4)}`;
    db.prepare(`INSERT INTO inventory (item_id,name,sku,type,unit,stock,reorder_pt,cost_price,sell_price) VALUES (?,?,?,?,?,?,?,?,?)`).run(item_id, name, sku||null, type||'Product', unit||'pcs', stock||0, reorder_pt||(type==='Product'?200:15), cost_price||0, sell_price||null);
    res.status(201).json({ item_id });
  });

  r.patch('/:item_id/stock', (req, res) => {
    const { action, qty, notes } = req.body;
    const item = db.prepare('SELECT * FROM inventory WHERE item_id=?').get(req.params.item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let newStock = item.stock;
    if (action === 'add')    newStock = item.stock + qty;
    else if (action === 'remove') newStock = Math.max(0, item.stock - qty);
    else if (action === 'set')    newStock = qty;

    db.prepare(`UPDATE inventory SET stock=?, updated_at=datetime('now') WHERE item_id=?`).run(newStock, req.params.item_id);
    db.prepare(`INSERT INTO inventory_logs (item_id,action,qty_before,qty_change,qty_after,notes,created_by) VALUES (?,?,?,?,?,?,?)`).run(req.params.item_id, action, item.stock, qty, newStock, notes||null, req.user?.id||1);
    res.json({ success: true, new_stock: newStock });
  });

  return r;
}

/* ─── EXPENSES ────────────────────────────────────────────── */
function expensesRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const { category, search, page=1, per_page=25 } = req.query;
    let sql = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];
    if (category && category !== 'All') { sql += ' AND category=?'; params.push(category); }
    if (search) { sql += ' AND (item_name LIKE ? OR noted_by LIKE ?)'; const q=`%${search}%`; params.push(q,q); }
    const total = db.prepare(`SELECT COUNT(*) as c ${sql.slice(sql.indexOf('FROM'))}`).get(...params).c;
    sql += ' ORDER BY exp_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data: db.prepare(sql).all(...params), total });
  });

  r.post('/', (req, res) => {
    const { exp_date, category, item_name, quantity, unit_price, noted_by } = req.body;
    if (!category || !item_name || !unit_price) return res.status(400).json({ error: 'Required fields missing' });
    const ref = `EXP-${String(Date.now()).slice(-6)}`;
    db.prepare(`INSERT INTO expenses (expense_ref,exp_date,category,item_name,quantity,unit_price,noted_by,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(ref, exp_date||new Date().toISOString().split('T')[0], category, item_name, quantity||1, unit_price, noted_by||null, req.user?.id||1);
    res.status(201).json({ expense_ref: ref });
  });

  r.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  return r;
}

/* ─── DAILY PICKUPS ───────────────────────────────────────── */
function pickupsRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const { page=1, per_page=25 } = req.query;
    const total = db.prepare('SELECT COUNT(*) as c FROM daily_pickups').get().c;
    const data = db.prepare('SELECT * FROM daily_pickups ORDER BY pickup_date DESC LIMIT ? OFFSET ?').all(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data, total });
  });

  r.post('/', (req, res) => {
    const { pickup_date, product_name, product_type, customer_orders, total_pieces, notes } = req.body;
    if (!product_name || !customer_orders || !total_pieces) return res.status(400).json({ error: 'Required fields missing' });
    const ref = `PU-${String(Date.now()).slice(-6)}`;
    db.prepare(`INSERT INTO daily_pickups (pickup_ref,pickup_date,product_name,product_type,customer_orders,total_pieces,notes,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(ref, pickup_date||new Date().toISOString().split('T')[0], product_name, product_type||'Product', customer_orders, total_pieces, notes||null, req.user?.id||1);
    res.status(201).json({ pickup_ref: ref });
  });

  return r;
}

/* ─── SCANS ───────────────────────────────────────────────── */
function scansRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const { type, page=1, per_page=25 } = req.query;
    let sql = 'SELECT * FROM scan_records WHERE 1=1';
    const params = [];
    if (type) { sql += ' AND scan_type=?'; params.push(type); }
    const total = db.prepare(`SELECT COUNT(*) as c ${sql.slice(sql.indexOf('FROM'))}`).get(...params).c;
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(per_page), (parseInt(page)-1)*parseInt(per_page));
    res.json({ data: db.prepare(sql).all(...params), total });
  });

  r.get('/lookup/:tracking', (req, res) => {
    const tracking = req.params.tracking.trim();
    // First check scan records
    let found = db.prepare('SELECT * FROM scan_records WHERE LOWER(tracking_no)=LOWER(?) ORDER BY created_at DESC LIMIT 1').get(tracking);
    if (!found) {
      // Check orders
      const order = db.prepare('SELECT * FROM orders WHERE LOWER(tracking_no)=LOWER(?)').get(tracking);
      if (order) {
        found = { tracking_no: order.tracking_no, customer: order.customer, phone: order.phone, status: order.status, courier: order.courier, scan_date: order.order_date };
      }
    }
    if (!found) return res.status(404).json({ error: 'Tracking number not found', tracking_no: tracking });
    res.json(found);
  });

  r.post('/', (req, res) => {
    const { tracking_no, customer, phone, status, courier, scan_type, scan_date } = req.body;
    if (!tracking_no) return res.status(400).json({ error: 'Tracking number required' });
    const ref = `SCN-${String(Date.now()).slice(-6)}`;
    db.prepare(`INSERT INTO scan_records (scan_ref,tracking_no,customer,phone,scan_date,status,courier,scan_type,scanned_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(ref, tracking_no, customer||null, phone||null, scan_date||new Date().toISOString().split('T')[0], status||null, courier||null, scan_type||'Standard', req.user?.id||1);
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
