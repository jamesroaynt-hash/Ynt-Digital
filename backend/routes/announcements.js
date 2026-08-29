const express = require('express');

// Administrator, HR and Operation all manage HR: Operation was granted HR's
// access, so it clears every gate HR clears. Role text is typed by hand on
// accounts, hence the lowercase compare and the plural spelling.
const HR_MANAGER_ROLES = new Set(['administrator', 'hr', 'operation', 'operations']);

module.exports = function announcementsRoutes(db) {
  const router = express.Router();

  function canManage(req) {
    return HR_MANAGER_ROLES.has(String(req.user?.role || '').trim().toLowerCase());
  }

  router.get('/', async (req, res) => {
    try {
      const rows = await db.prepare(`
        SELECT a.id, a.title, a.body, a.posted_at, a.expires_at, a.is_active,
               u.full_name AS posted_by_name, u.username AS posted_by_username
        FROM announcements a
        LEFT JOIN users u ON u.id = a.posted_by
        WHERE a.is_active = 1
        ORDER BY a.posted_at DESC
        LIMIT 50
      `).all();
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    if (!canManage(req)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const title = String(req.body?.title || '').trim();
      const body = String(req.body?.body || '').trim();
      const expiresAt = String(req.body?.expires_at || '').trim() || null;
      if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
      const result = await db.prepare(`
        INSERT INTO announcements (title, body, posted_by, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(title, body, req.user?.id || null, expiresAt);
      res.status(201).json({ id: Number(result.lastInsertRowid) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    if (!canManage(req)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      await db.prepare('UPDATE announcements SET is_active = 0 WHERE id = ?').run(id);
      res.json({ deleted: id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
