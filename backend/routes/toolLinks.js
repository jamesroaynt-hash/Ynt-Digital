const express = require('express');

// Tool links (top-bar dropdown): outside sites the team uses. Anyone signed in
// reads the list; only the super admin adds, edits or removes links.

function text(value, max) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

// http(s) only, so a link can never run script when clicked. A bare domain
// ("sheets.google.com") gets https:// in front.
function cleanUrl(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

function clean(body) {
  const order = Math.trunc(Number(body.sort_order));
  return {
    name: text(body.name, 80),
    url: cleanUrl(body.url),
    // An emoji or a couple of letters; anything longer is not an icon.
    icon: text(body.icon, 8),
    sort_order: Number.isFinite(order) ? order : 0,
  };
}

module.exports = function toolLinksRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.use((req, res, next) => (req.user?.role === 'api_key'
    ? res.status(403).json({ error: 'Not available to API keys' })
    : next()));

  const requireSuperAdmin = wrap(async (req, res, next) => {
    const user = req.user?.id
      ? await db.prepare('SELECT id, is_super_admin FROM users WHERE id = ? AND is_active = 1').get(req.user.id)
      : null;
    if (!user || Number(user.is_super_admin) !== 1) {
      return res.status(403).json({ error: 'Only the super admin manages tool links' });
    }
    req.toolUser = user;
    return next();
  });

  const list = () => db.prepare('SELECT id, name, url, icon, sort_order FROM tool_links ORDER BY sort_order ASC, name ASC, id ASC').all();

  router.get('/', wrap(async (req, res) => {
    res.json({ rows: await list() });
  }));

  router.post('/', requireSuperAdmin, wrap(async (req, res) => {
    const values = clean(req.body || {});
    if (!values.name) return res.status(400).json({ error: 'Give the link a name' });
    if (!values.url) return res.status(400).json({ error: 'Enter a valid http(s) link' });
    await db.prepare('INSERT INTO tool_links (name, url, icon, sort_order, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(values.name, values.url, values.icon, values.sort_order, req.toolUser.id);
    res.status(201).json({ rows: await list() });
  }));

  router.put('/:id', requireSuperAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const existing = Number.isInteger(id) ? await db.prepare('SELECT * FROM tool_links WHERE id = ?').get(id) : null;
    if (!existing) return res.status(404).json({ error: 'Link not found' });
    const values = clean({ ...existing, ...(req.body || {}) });
    if (!values.name) return res.status(400).json({ error: 'Give the link a name' });
    if (!values.url) return res.status(400).json({ error: 'Enter a valid http(s) link' });
    await db.prepare('UPDATE tool_links SET name = ?, url = ?, icon = ?, sort_order = ? WHERE id = ?')
      .run(values.name, values.url, values.icon, values.sort_order, id);
    res.json({ rows: await list() });
  }));

  router.delete('/:id', requireSuperAdmin, wrap(async (req, res) => {
    await db.prepare('DELETE FROM tool_links WHERE id = ?').run(Number(req.params.id));
    res.json({ rows: await list() });
  }));

  return router;
};

module.exports.cleanUrl = cleanUrl;
