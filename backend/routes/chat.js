const express = require('express');

// Internal team group chat: one shared channel every dashboard user can read and
// post to. Kept deliberately simple — the frontend polls GET /?after=<id> for new
// messages rather than using websockets.
module.exports = function chatRoutes(db) {
  const router = express.Router();

  const MAX_BODY = 2000;

  function canModerate(req) {
    const role = String(req.user?.role || '').trim();
    return role === 'Administrator' || role === 'HR';
  }

  // GET /            → latest messages (chronological, capped)
  // GET /?after=<id> → only messages newer than <id> (for polling)
  router.get('/', async (req, res) => {
    try {
      const after = Number(req.query.after);
      if (Number.isFinite(after) && after > 0) {
        const rows = await db.prepare(`
          SELECT c.id, c.user_id, c.body, c.created_at,
                 u.full_name AS author_name, u.username AS author_username, u.role AS author_role
          FROM chat_messages c
          LEFT JOIN users u ON u.id = c.user_id
          WHERE c.id > ?
          ORDER BY c.id ASC
          LIMIT 200
        `).all(after);
        return res.json({ data: rows });
      }
      // Newest 100, returned oldest-first so the client can append downward.
      const rows = await db.prepare(`
        SELECT id, user_id, body, created_at, author_name, author_username, author_role
        FROM (
          SELECT c.id, c.user_id, c.body, c.created_at,
                 u.full_name AS author_name, u.username AS author_username, u.role AS author_role
          FROM chat_messages c
          LEFT JOIN users u ON u.id = c.user_id
          ORDER BY c.id DESC
          LIMIT 100
        ) recent
        ORDER BY id ASC
      `).all();
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const body = String(req.body?.body || '').trim();
      if (!body) return res.status(400).json({ error: 'Message body is required' });
      if (body.length > MAX_BODY) return res.status(400).json({ error: `Message must be ${MAX_BODY} characters or fewer` });
      const result = await db.prepare(`
        INSERT INTO chat_messages (user_id, body)
        VALUES (?, ?)
      `).run(req.user?.id || null, body);
      const id = Number(result.lastInsertRowid);
      const row = await db.prepare(`
        SELECT c.id, c.user_id, c.body, c.created_at,
               u.full_name AS author_name, u.username AS author_username, u.role AS author_role
        FROM chat_messages c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.id = ?
      `).get(id);
      res.status(201).json({ data: row });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Author can delete their own message; Administrator/HR can delete any.
  router.delete('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const row = await db.prepare('SELECT user_id FROM chat_messages WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Message not found' });
      if (row.user_id !== req.user?.id && !canModerate(req)) {
        return res.status(403).json({ error: 'You can only delete your own messages' });
      }
      await db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
      res.json({ deleted: id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
