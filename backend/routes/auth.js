const express = require('express');

module.exports = function authRoutes(db, jwt, bcrypt, JWT_SECRET) {
  const router = express.Router();
  const allowedRoles = new Set([
    'Administrator',
    'Trainee',
    'RMO',
    'CSR',
    'Logistics',
    'Sales and Marketing',
  ]);

  function isPasswordMatch(input, stored) {
    if (!stored) return false;
    if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
      return bcrypt.compareSync(input, stored);
    }
    return input === stored;
  }

  function getRequestUser(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.prepare(`
        SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, is_active
        FROM users
        WHERE id = ?
      `).get(decoded.id);

      if (!user || !user.is_active) return null;

      return {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        birthday: user.birthday,
        address: user.address,
        phone_number: user.phone_number,
        email_address: user.email_address,
        fb_account_name: user.fb_account_name,
      };
    } catch {
      return null;
    }
  }

  function requireAdmin(req, res, next) {
    const user = getRequestUser(req);
    if (!user || String(user.role || '').trim() !== 'Administrator') {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    req.user = user;
    next();
  }

  function requireAuth(req, res, next) {
    const user = getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = user;
    next();
  }

  function normalizeRole(role, fallback = 'Trainee') {
    const rawValue = String(role || fallback).trim() || fallback;
    const value = rawValue.toLowerCase() === 'admin' ? 'Administrator' : rawValue;
    if (value.toLowerCase() === 'staff') return fallback;
    return allowedRoles.has(value) ? value : fallback;
  }

  function getActiveAdminCount() {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE is_active = 1 AND role = 'Administrator'
    `).get();
    return Number(row?.count || 0);
  }

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
    if (!user || !isPasswordMatch(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        birthday: user.birthday,
        address: user.address,
        phone_number: user.phone_number,
        email_address: user.email_address,
        fb_account_name: user.fb_account_name,
      },
    });
  });

  // POST /api/auth/register
  router.post('/register', requireAdmin, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.full_name || req.body?.name || '').trim();
    const role = normalizeRole(req.body?.role, 'Trainee');
    const birthday = String(req.body?.birthday || '').trim();
    const address = String(req.body?.address || '').trim();
    const phoneNumber = String(req.body?.phone_number || '').trim();
    const emailAddress = String(req.body?.email_address || '').trim();
    const fbAccountName = String(req.body?.fb_account_name || '').trim();

    if (!username || !password || !fullName) {
      return res.status(400).json({ error: 'Username, password, and full name are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const insert = db.prepare(`
      INSERT INTO users (username, password, full_name, role, birthday, address, phone_number, email_address, fb_account_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(username, hashedPassword, fullName, role, birthday || null, address || null, phoneNumber || null, emailAddress || null, fbAccountName || null);

    const user = db.prepare('SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name FROM users WHERE id = ?').get(result.lastInsertRowid);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        birthday: user.birthday,
        address: user.address,
        phone_number: user.phone_number,
        email_address: user.email_address,
        fb_account_name: user.fb_account_name,
      },
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
  });

  // GET /api/auth/me
  router.get('/me', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name FROM users WHERE id=?').get(decoded.id);
      res.json(user);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  router.put('/me', requireAuth, (req, res) => {
    const userId = Number(req.user.id);
    const existing = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
    if (!existing || !existing.is_active) {
      return res.status(404).json({ error: 'User not found' });
    }

    const username = String(req.body?.username || '').trim();
    const fullName = String(req.body?.full_name || req.body?.name || '').trim();
    const password = String(req.body?.password || '');
    const birthday = String(req.body?.birthday || '').trim();
    const address = String(req.body?.address || '').trim();
    const phoneNumber = String(req.body?.phone_number || '').trim();
    const emailAddress = String(req.body?.email_address || '').trim();
    const fbAccountName = String(req.body?.fb_account_name || '').trim();

    if (!username || !fullName) {
      return res.status(400).json({ error: 'Username and full name are required' });
    }

    const usernameOwner = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, userId);
    if (usernameOwner) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const nextPassword = password ? bcrypt.hashSync(password, 10) : null;
    db.prepare(`
      UPDATE users
      SET username = ?,
          full_name = ?,
          birthday = ?,
          address = ?,
          phone_number = ?,
          email_address = ?,
          fb_account_name = ?,
          password = COALESCE(?, password),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(username, fullName, birthday || null, address || null, phoneNumber || null, emailAddress || null, fbAccountName || null, nextPassword, userId);

    const user = db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name
      FROM users
      WHERE id = ?
    `).get(userId);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        birthday: user.birthday,
        address: user.address,
        phone_number: user.phone_number,
        email_address: user.email_address,
        fb_account_name: user.fb_account_name,
      },
    });
  });

  router.get('/users', requireAdmin, (req, res) => {
    const users = db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, is_active, created_at, updated_at
      FROM users
      WHERE is_active = 1
      ORDER BY
        CASE
          WHEN role = 'Administrator' THEN 0
          WHEN role = 'CSR' THEN 1
          WHEN role = 'Trainee' THEN 2
          WHEN role = 'RMO' THEN 3
          WHEN role = 'Logistics' THEN 4
          WHEN role = 'Sales and Marketing' THEN 5
          ELSE 6
        END,
        full_name COLLATE NOCASE ASC,
        username COLLATE NOCASE ASC
    `).all();

    res.json({ users });
  });

  router.put('/users/:id', requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const existing = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
    if (!existing || !existing.is_active) {
      return res.status(404).json({ error: 'User not found' });
    }

    const username = String(req.body?.username || '').trim();
    const fullName = String(req.body?.full_name || req.body?.name || '').trim();
    const role = normalizeRole(req.body?.role, existing.role);
    const password = String(req.body?.password || '');
    const birthday = String(req.body?.birthday || '').trim();
    const address = String(req.body?.address || '').trim();
    const phoneNumber = String(req.body?.phone_number || '').trim();
    const emailAddress = String(req.body?.email_address || '').trim();
    const fbAccountName = String(req.body?.fb_account_name || '').trim();

    if (!username || !fullName) {
      return res.status(400).json({ error: 'Username and full name are required' });
    }

    const usernameOwner = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, userId);
    if (usernameOwner) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    if (existing.role === 'Administrator' && role !== 'Administrator' && getActiveAdminCount() <= 1) {
      return res.status(400).json({ error: 'At least one active administrator account must remain' });
    }

    const nextPassword = password ? bcrypt.hashSync(password, 10) : null;
    db.prepare(`
      UPDATE users
      SET username = ?,
          full_name = ?,
          role = ?,
          birthday = ?,
          address = ?,
          phone_number = ?,
          email_address = ?,
          fb_account_name = ?,
          password = COALESCE(?, password),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(username, fullName, role, birthday || null, address || null, phoneNumber || null, emailAddress || null, fbAccountName || null, nextPassword, userId);

    const user = db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, is_active, created_at, updated_at
      FROM users
      WHERE id = ?
    `).get(userId);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        birthday: user.birthday,
        address: user.address,
        phone_number: user.phone_number,
        email_address: user.email_address,
        fb_account_name: user.fb_account_name,
      },
      meta: { is_active: user.is_active, created_at: user.created_at, updated_at: user.updated_at },
    });
  });

  router.delete('/users/:id', requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (req.user.id === userId) {
      return res.status(400).json({ error: 'You cannot delete your own account while signed in' });
    }

    const existing = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(userId);
    if (!existing || !existing.is_active) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (existing.role === 'Administrator' && getActiveAdminCount() <= 1) {
      return res.status(400).json({ error: 'At least one active administrator account must remain' });
    }

    db.prepare(`
      UPDATE users
      SET is_active = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(userId);

    res.json({ success: true });
  });

  return router;
};
