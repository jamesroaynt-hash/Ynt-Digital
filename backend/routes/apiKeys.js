const express = require('express');
const crypto = require('crypto');

const ALLOWED_SCOPES = [
  'orders:read', 'orders:write',
  'inventory:read', 'inventory:write',
  'expenses:read', 'expenses:write',
  'hr:read',
];

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  const raw = crypto.randomBytes(32).toString('hex');
  const full = `yntk_${raw}`;
  const prefix = `yntk_${raw.slice(0, 8)}`;
  return { full, prefix, hash: hashKey(full) };
}

function requireAdmin(req, res, next) {
  if (String(req.user?.role || '').trim() !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  return next();
}

module.exports = function apiKeysRoutes(db) {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/', async (req, res) => {
    try {
      const keys = await db.prepare(`
        SELECT ak.id, ak.name, ak.key_prefix, ak.scopes, ak.last_used_at, ak.is_active, ak.created_at,
               u.full_name AS created_by_name
        FROM api_keys ak
        LEFT JOIN users u ON u.id = ak.created_by
        ORDER BY ak.created_at DESC
      `).all();
      res.json(keys.map((k) => ({ ...k, scopes: JSON.parse(k.scopes || '[]') })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    const { name, scopes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const requestedScopes = Array.isArray(scopes) ? scopes : ['orders:read'];
    const validScopes = requestedScopes.filter((s) => ALLOWED_SCOPES.includes(s));
    if (!validScopes.length) {
      return res.status(400).json({ error: `scopes must include at least one of: ${ALLOWED_SCOPES.join(', ')}` });
    }

    const { full, prefix, hash } = generateApiKey();
    try {
      const ins = await db.prepare(
        'INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(String(name).trim(), prefix, hash, JSON.stringify(validScopes), req.user?.id || null);

      res.status(201).json({
        id: ins.lastInsertRowid,
        name: String(name).trim(),
        key: full,
        key_prefix: prefix,
        scopes: validScopes,
        note: 'Copy this key now — it will not be shown again. Use it as: Authorization: ApiKey <key>',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    try {
      const result = await db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(req.params.id);
      if (!result.changes) return res.status(404).json({ error: 'API key not found' });
      res.json({ message: 'API key revoked' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return r;
};

module.exports.hashKey = hashKey;
module.exports.ALLOWED_SCOPES = ALLOWED_SCOPES;
