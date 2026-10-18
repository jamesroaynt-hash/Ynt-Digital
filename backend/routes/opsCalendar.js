const express = require('express');

// Operations calendar (Operations → Calendar): supplier deliveries, courier
// pickups, stock counts and other logistics dates. Anyone signed in can read
// it; Administrator, Logistics, Operation and the super admin edit it.
const WRITE_ROLES = new Set(['administrator', 'logistics', 'operation', 'operations']);
const CATEGORIES = ['Supplier Delivery', 'Courier Pickup', 'Stock Count', 'Restock Order', 'Payment', 'Other'];
const STATUSES = ['Scheduled', 'Delivered', 'Delayed', 'Cancelled'];
const REPEATS = ['none', 'weekly', 'monthly'];

function date(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function text(value, max = 2000) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function clean(body) {
  const qty = Math.trunc(Number(body.qty));
  return {
    event_date: date(body.event_date),
    event_time: /^\d{2}:\d{2}$/.test(String(body.event_time || '')) ? body.event_time : null,
    category: CATEGORIES.includes(body.category) ? body.category : 'Supplier Delivery',
    title: text(body.title, 300),
    item_id: text(body.item_id, 64),
    qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    supplier: text(body.supplier, 160),
    status: STATUSES.includes(body.status) ? body.status : 'Scheduled',
    repeat_rule: REPEATS.includes(body.repeat_rule) ? body.repeat_rule : 'none',
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

  // Repeating events are expanded on the page, so they come back whatever the
  // range; one-off events only inside it.
  router.get('/', wrap(async (req, res) => {
    const from = date(req.query.from);
    const to = date(req.query.to);
    const params = [];
    let where = '';
    if (from && to) {
      where = "WHERE (e.repeat_rule <> 'none' OR e.event_date BETWEEN ? AND ?)";
      params.push(from, to);
    }
    const rows = await db.prepare(`${selectSql} ${where} ORDER BY e.event_date ASC, e.event_time ASC, e.id ASC`).all(...params);
    res.json({ rows, categories: CATEGORIES, statuses: STATUSES });
  }));

  router.post('/', requireWrite, wrap(async (req, res) => {
    const values = clean(req.body || {});
    if (!values.event_date || !values.title) return res.status(400).json({ error: 'Date and title are required' });
    const columns = Object.keys(values);
    const result = await db.prepare(`
      INSERT INTO ops_calendar_events (${columns.join(', ')}, created_by)
      VALUES (${columns.map(() => '?').join(', ')}, ?)
    `).run(...columns.map((c) => values[c]), req.calendarUser.id);
    const row = await db.prepare(`${selectSql} WHERE e.id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ row });
  }));

  router.put('/:id', requireWrite, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const existing = Number.isInteger(id) ? await db.prepare('SELECT * FROM ops_calendar_events WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    const values = clean({ ...existing, ...(req.body || {}) });
    if (!values.event_date || !values.title) return res.status(400).json({ error: 'Date and title are required' });
    const columns = Object.keys(values);
    await db.prepare(`
      UPDATE ops_calendar_events SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?
    `).run(...columns.map((c) => values[c]), id);
    const row = await db.prepare(`${selectSql} WHERE e.id = ?`).get(id);
    res.json({ row });
  }));

  router.delete('/:id', requireWrite, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const result = await db.prepare('DELETE FROM ops_calendar_events WHERE id = ?').run(id);
    if (!result.changes) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true });
  }));

  return router;
};
