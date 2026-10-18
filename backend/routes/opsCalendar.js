const express = require('express');

// Operations calendar (Operations → Calendar): tracks incoming orders from
// suppliers. Each order sits on the calendar on its expected arrival date
// (event_date) and moves Ordered → Paid → In Transit → Arrived. Anyone signed
// in can read it; Administrator, Logistics, Operation and the super admin edit
// it. Arrival is tracked only: stock is still added on the Inventory page.
const WRITE_ROLES = new Set(['administrator', 'logistics', 'operation', 'operations']);
const STATUSES = ['Ordered', 'Paid', 'In Transit', 'Arrived', 'Delayed', 'Cancelled'];
// Names the first release of the calendar used.
const LEGACY_STATUS = { Scheduled: 'Ordered', Delivered: 'Arrived' };

function date(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function text(value, max = 2000) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function count(value) {
  const n = Math.trunc(Number(value));
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n) && n >= 0 ? n : null;
}

function clean(body) {
  const status = LEGACY_STATUS[body.status] || body.status;
  const amount = Number(body.amount);
  return {
    event_date: date(body.event_date),
    event_time: /^\d{2}:\d{2}$/.test(String(body.event_time || '')) ? body.event_time : null,
    category: 'Supplier Order',
    title: text(body.title, 300),
    item_id: text(body.item_id, 64),
    qty: count(body.qty),
    qty_received: count(body.qty_received),
    supplier: text(body.supplier, 160),
    po_number: text(body.po_number, 80),
    order_date: date(body.order_date),
    amount: body.amount !== '' && body.amount !== null && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null,
    courier: text(body.courier, 120),
    tracking_no: text(body.tracking_no, 120),
    status: STATUSES.includes(status) ? status : 'Ordered',
    repeat_rule: 'none',
    notes: text(body.notes),
  };
}

module.exports = function opsCalendarRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.use((req, res, next) => (req.user?.role === 'api_key'
    ? res.status(403).json({ error: 'Not available to API keys' })
    : next()));

  const requireWrite = wrap(async (req, res, next) => {
    const user = req.user?.id
      ? await db.prepare('SELECT id, role, is_super_admin FROM users WHERE id = ?').get(req.user.id)
      : null;
    const role = String(user?.role || '').trim().toLowerCase();
    if (!user || (!WRITE_ROLES.has(role) && Number(user.is_super_admin) !== 1)) {
      return res.status(403).json({ error: 'Administrator, Logistics or Operation access required' });
    }
    req.calendarUser = user;
    return next();
  });

  const selectSql = `
    SELECT e.*, i.name AS item_name, i.unit AS item_unit, u.full_name AS created_by_name
    FROM ops_calendar_events e
    LEFT JOIN inventory i ON i.item_id = e.item_id
    LEFT JOIN users u ON u.id = e.created_by`;

  const shape = (row) => (row ? { ...row, status: LEGACY_STATUS[row.status] || row.status } : row);

  // An order needs a name: the title, else the product it is for.
  async function withTitle(values) {
    if (values.title || !values.item_id) return values;
    const item = await db.prepare('SELECT name FROM inventory WHERE item_id = ?').get(values.item_id);
    return { ...values, title: item?.name || null };
  }

  // ?from&to limits to orders expected in that range; open orders that are
  // already late come back too, so nothing overdue drops off the page.
  router.get('/', wrap(async (req, res) => {
    const from = date(req.query.from);
    const to = date(req.query.to);
    const params = [];
    let where = '';
    if (from && to) {
      where = "WHERE (e.event_date BETWEEN ? AND ?) OR (e.event_date < ? AND e.status NOT IN ('Arrived', 'Delivered', 'Cancelled'))";
      params.push(from, to, from);
    }
    const rows = await db.prepare(`${selectSql} ${where} ORDER BY e.event_date ASC, e.event_time ASC, e.id ASC`).all(...params);
    res.json({ rows: rows.map(shape), statuses: STATUSES });
  }));

  router.post('/', requireWrite, wrap(async (req, res) => {
    const values = await withTitle(clean(req.body || {}));
    if (!values.event_date) return res.status(400).json({ error: 'Expected arrival date is required' });
    if (!values.title) return res.status(400).json({ error: 'Pick a product or give the order a title' });
    const columns = Object.keys(values);
    const result = await db.prepare(`
      INSERT INTO ops_calendar_events (${columns.join(', ')}, created_by)
      VALUES (${columns.map(() => '?').join(', ')}, ?)
    `).run(...columns.map((c) => values[c]), req.calendarUser.id);
    const row = await db.prepare(`${selectSql} WHERE e.id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ row: shape(row) });
  }));

  router.put('/:id', requireWrite, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const existing = Number.isInteger(id) ? await db.prepare('SELECT * FROM ops_calendar_events WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    const values = await withTitle(clean({ ...existing, ...(req.body || {}) }));
    if (!values.event_date) return res.status(400).json({ error: 'Expected arrival date is required' });
    if (!values.title) return res.status(400).json({ error: 'Pick a product or give the order a title' });
    const columns = Object.keys(values);
    await db.prepare(`
      UPDATE ops_calendar_events SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?
    `).run(...columns.map((c) => values[c]), id);
    const row = await db.prepare(`${selectSql} WHERE e.id = ?`).get(id);
    res.json({ row: shape(row) });
  }));

  router.delete('/:id', requireWrite, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await db.prepare('DELETE FROM ops_calendar_events WHERE id = ?').run(id);
    if (!result.changes) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  }));

  return router;
};
