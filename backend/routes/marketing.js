const express = require('express');

module.exports = function marketingRoutes(db) {
  const router = express.Router();

  function canManage(req) {
    const role = String(req.user?.role || '').trim();
    return role === 'Administrator' || role === 'Sales and Marketing TL';
  }

  function serializeEntry(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      date: row.entry_date || '',
      page: row.page || '',
      product: row.product || '',
      owner: row.owner || '',
      spend: Number(row.spend || 0),
      sales: Number(row.sales || 0),
      orders: Number(row.orders || 0),
      rts: Number(row.rts || 0),
    };
  }

  function readBody(req) {
    const body = req.body || {};
    return {
      date: String(body.date || '').trim(),
      page: String(body.page || '').trim(),
      product: String(body.product || '').trim() || null,
      owner: String(body.owner || '').trim() || null,
      spend: Math.max(0, Number(body.spend || 0)),
      sales: Math.max(0, Number(body.sales || 0)),
      orders: Math.max(0, Number(body.orders || 0) | 0),
      rts: Math.max(0, Number(body.rts || 0) | 0),
    };
  }

  router.get('/entries', async (req, res) => {
    try {
      const from = String(req.query?.from || '').trim();
      const to = String(req.query?.to || '').trim();
      const clauses = [];
      const params = [];
      if (from) { clauses.push('entry_date >= ?'); params.push(from); }
      if (to) { clauses.push('entry_date <= ?'); params.push(to); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.prepare(`
        SELECT id, entry_date, page, product, owner, spend, sales, orders, rts
        FROM marketing_entries
        ${where}
        ORDER BY entry_date ASC, id ASC
      `).all(...params);
      res.json({ entries: rows.map(serializeEntry) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/entries', async (req, res) => {
    if (!canManage(req)) return res.status(403).json({ error: 'Sales and Marketing TL or Administrator access required' });
    try {
      const data = readBody(req);
      if (!data.date) return res.status(400).json({ error: 'date is required' });
      if (!data.page) return res.status(400).json({ error: 'page is required' });
      const result = await db.prepare(`
        INSERT INTO marketing_entries (entry_date, page, product, owner, spend, sales, orders, rts, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.date, data.page, data.product, data.owner, data.spend, data.sales, data.orders, data.rts, req.user?.id || null);
      const id = Number(result.lastInsertRowid);
      const row = await db.prepare(`
        SELECT id, entry_date, page, product, owner, spend, sales, orders, rts
        FROM marketing_entries WHERE id = ?
      `).get(id);
      res.status(201).json({ entry: serializeEntry(row) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/entries/:id', async (req, res) => {
    if (!canManage(req)) return res.status(403).json({ error: 'Sales and Marketing TL or Administrator access required' });
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid entry id' });
      const existing = await db.prepare('SELECT id FROM marketing_entries WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      const data = readBody(req);
      if (!data.date) return res.status(400).json({ error: 'date is required' });
      if (!data.page) return res.status(400).json({ error: 'page is required' });
      await db.prepare(`
        UPDATE marketing_entries
        SET entry_date = ?, page = ?, product = ?, owner = ?,
            spend = ?, sales = ?, orders = ?, rts = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(data.date, data.page, data.product, data.owner, data.spend, data.sales, data.orders, data.rts, id);
      const row = await db.prepare(`
        SELECT id, entry_date, page, product, owner, spend, sales, orders, rts
        FROM marketing_entries WHERE id = ?
      `).get(id);
      res.json({ entry: serializeEntry(row) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/entries/:id', async (req, res) => {
    if (!canManage(req)) return res.status(403).json({ error: 'Sales and Marketing TL or Administrator access required' });
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid entry id' });
      const existing = await db.prepare('SELECT id FROM marketing_entries WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      await db.prepare('DELETE FROM marketing_entries WHERE id = ?').run(id);
      res.json({ deleted: true, id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
