const express = require('express');
const crypto = require('crypto');

const ALLOWED_EVENTS = [
  'order.created', 'order.updated', 'order.deleted',
  'inventory.updated',
  '*',
];

function requireAdmin(req, res, next) {
  if (String(req.user?.role || '').trim() !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  return next();
}

module.exports = function webhooksRoutes(db) {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/', async (req, res) => {
    try {
      const subs = await db.prepare(
        'SELECT id, name, url, events, is_active, created_at, updated_at FROM webhook_subscriptions ORDER BY created_at DESC'
      ).all();
      res.json(subs.map((s) => ({ ...s, events: JSON.parse(s.events || '[]') })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    const { name, url, events } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!url?.trim()) return res.status(400).json({ error: 'url is required' });

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'url is not a valid URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'url must use http or https' });
    }

    const requestedEvents = Array.isArray(events) ? events : ['order.created'];
    const validEvents = requestedEvents.filter((e) => ALLOWED_EVENTS.includes(e));
    if (!validEvents.length) {
      return res.status(400).json({ error: `events must include at least one of: ${ALLOWED_EVENTS.join(', ')}` });
    }

    const secret = crypto.randomBytes(24).toString('hex');
    try {
      const ins = await db.prepare(
        'INSERT INTO webhook_subscriptions (name, url, events, secret, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(String(name).trim(), String(url).trim(), JSON.stringify(validEvents), secret, req.user?.id || null);

      res.status(201).json({
        id: ins.lastInsertRowid,
        name: String(name).trim(),
        url: String(url).trim(),
        events: validEvents,
        secret,
        note: 'Verify incoming requests using X-YNT-Signature (HMAC-SHA256 of the raw body). Secret shown once.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.patch('/:id', async (req, res) => {
    const { is_active, name, events } = req.body || {};
    const updates = [];
    const params = [];

    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (name?.trim()) { updates.push('name = ?'); params.push(String(name).trim()); }
    if (Array.isArray(events)) {
      const valid = events.filter((e) => ALLOWED_EVENTS.includes(e));
      if (valid.length) { updates.push('events = ?'); params.push(JSON.stringify(valid)); }
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    try {
      await db.prepare(`UPDATE webhook_subscriptions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      res.json({ message: 'Updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const result = await db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(req.params.id);
      if (!result.changes) return res.status(404).json({ error: 'Webhook subscription not found' });
      res.json({ message: 'Webhook deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/:id/deliveries', async (req, res) => {
    try {
      const deliveries = await db.prepare(`
        SELECT id, event, status, response_status, response_body, attempts, delivered_at, created_at
        FROM webhook_deliveries WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 50
      `).all(req.params.id);
      res.json(deliveries);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
};

module.exports.ALLOWED_EVENTS = ALLOWED_EVENTS;
