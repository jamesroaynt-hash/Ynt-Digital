const express = require('express');
const crypto = require('crypto');
const storage = require('../services/supabaseStorage');

// File Uploads: drag files onto the dashboard and they're stored in Supabase
// Storage, one folder per page under each category:
//   Page Details/<page>/…   Customer Feedbacks/<page>/…
// Every signed-in user may upload and view; a file is deleted by whoever
// uploaded it, an Administrator or the super admin.

const CATEGORIES = ['Page Details', 'Customer Feedbacks'];

function text(value, max = 200) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

// Display names keep what the user typed, minus slashes and control characters.
function cleanName(value, max = 200) {
  const raw = text(value, max);
  return raw ? raw.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f]/g, '').trim() || null : null;
}

// Storage keys accept a narrow character set (no accents, emoji or most
// punctuation), so the key gets a safe copy; the real name stays in the table.
function keySegment(value) {
  return String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w .()-]/g, '_').replace(/_+/g, '_').trim().slice(0, 120) || 'file';
}

function fileUploadsRoutes(db) {
  const router = express.Router();

  async function currentUser(req) {
    if (!req.user?.id) return null;
    return db.prepare('SELECT id, username, full_name, role, is_super_admin FROM users WHERE id = ?').get(req.user.id);
  }

  const isManager = (user) => String(user?.role || '').trim().toLowerCase() === 'administrator' || Number(user?.is_super_admin) === 1;

  function sendError(res, error) {
    return res.status(error?.statusCode && error.statusCode < 600 ? error.statusCode : 500).json({ error: error?.message || 'Upload request failed' });
  }

  router.get('/status', (req, res) => {
    res.json({
      configured: storage.configured(),
      categories: CATEGORIES,
      max_file_mb: storage.MAX_FILE_BYTES / 1024 / 1024,
    });
  });

  // Page names the dropdown offers: every page POS has orders for, plus any
  // typed in for an earlier upload.
  router.get('/pages', async (req, res) => {
    try {
      const rows = await db.prepare(
        "SELECT DISTINCT page_name FROM pos_orders WHERE page_name IS NOT NULL AND TRIM(page_name) != '' ORDER BY page_name"
      ).all();
      const used = await db.prepare('SELECT DISTINCT page_name FROM file_uploads').all();
      const names = new Set([...rows, ...used].map((r) => String(r.page_name).trim()).filter(Boolean));
      res.json({ pages: [...names].sort((a, b) => a.localeCompare(b)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/', async (req, res) => {
    try {
      const where = [];
      const params = [];
      const category = text(req.query.category);
      const page = text(req.query.page);
      if (category) { where.push('category = ?'); params.push(category); }
      if (page) { where.push('page_name = ?'); params.push(page); }
      const user = await currentUser(req);
      const rows = await db.prepare(`
        SELECT id, category, page_name, file_name, mime_type, size_bytes, uploaded_by, uploaded_by_name, created_at
        FROM file_uploads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT 200
      `).all(...params);
      res.json({
        rows: rows.map((r) => ({ ...r, can_delete: isManager(user) || Number(r.uploaded_by) === Number(user?.id) })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  // One file per request, sent as the raw body (application/octet-stream so
  // the global JSON parser never touches it); name and type ride in headers.
  router.post('/', express.raw({ type: 'application/octet-stream', limit: storage.MAX_FILE_BYTES }), async (req, res) => {
    try {
      if (!storage.configured()) return res.status(409).json({ error: 'File storage is not set up yet. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.' });
      const category = text(req.query.category);
      const pageName = cleanName(req.query.page, 120);
      const fileName = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || '')), 250);
      const mimeType = text(req.headers['x-file-type'], 120) || 'application/octet-stream';
      if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Pick Page Details or Customer Feedbacks' });
      if (!pageName) return res.status(400).json({ error: 'Pick a page' });
      if (!fileName) return res.status(400).json({ error: 'File name is missing' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'File is empty' });

      // A short random prefix keeps two uploads of "photo.jpg" from colliding.
      const objectPath = `${category}/${keySegment(pageName)}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${keySegment(fileName)}`;
      await storage.uploadObject(objectPath, req.body, mimeType);

      const user = await currentUser(req);
      const result = await db.prepare(`
        INSERT INTO file_uploads (category, page_name, file_name, object_path, mime_type, size_bytes, uploaded_by, uploaded_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(category, pageName, fileName, objectPath, mimeType, req.body.length, user?.id || null, user?.full_name || user?.username || null);
      res.status(201).json({ id: Number(result.lastInsertRowid) || null });
    } catch (error) {
      sendError(res, error);
    }
  });

  // A 10-minute link to view (or ?download=1 to save) one file.
  router.get('/:id/url', async (req, res) => {
    try {
      const row = await db.prepare('SELECT object_path FROM file_uploads WHERE id = ?').get(Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'File not found' });
      res.json({ url: await storage.signedUrl(row.object_path, { download: req.query.download === '1' }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const row = await db.prepare('SELECT id, object_path, uploaded_by FROM file_uploads WHERE id = ?').get(Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'File not found' });
      const user = await currentUser(req);
      if (!isManager(user) && Number(row.uploaded_by) !== Number(user?.id)) {
        return res.status(403).json({ error: 'Only the uploader or an Administrator can delete this file' });
      }
      await storage.removeObject(row.object_path);
      await db.prepare('DELETE FROM file_uploads WHERE id = ?').run(row.id);
      res.json({ deleted: true, id: row.id });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

module.exports = fileUploadsRoutes;
