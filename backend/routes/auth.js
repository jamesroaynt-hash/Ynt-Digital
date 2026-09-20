const express = require('express');

// Administrator, HR and Operation may manage accounts: Operation was granted
// HR's access, so it clears every gate HR clears. Role text is typed by hand
// on accounts, hence the lowercase compare and the plural spelling.
const HR_MANAGER_ROLES = new Set(['administrator', 'hr', 'operation', 'operations']);

module.exports = function authRoutes(db, jwt, bcrypt, JWT_SECRET, { tokenBlocklist = new Map(), loginAttempts = new Map() } = {}) {
  const router = express.Router();
  const allowedRoles = new Set([
    'Administrator',
    'HR',
    'Operation',
    'Trainee',
    'RMO',
    'RMO TL',
    'CSR',
    'CSR TL',
    'Logistics',
    'Sales and Marketing',
    'Sales and Marketing TL',
  ]);

  function isPasswordMatch(input, stored) {
    if (!stored) return false;
    if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
      return bcrypt.compareSync(input, stored);
    }
    return input === stored;
  }

  async function getRequestUser(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.prepare(`
        SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate, is_active
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
        daily_rate: user.daily_rate,
      };
    } catch {
      return null;
    }
  }

  async function requireAdmin(req, res, next) {
    const user = await getRequestUser(req);
    if (!user || !HR_MANAGER_ROLES.has(String(user.role || '').trim().toLowerCase())) {
      return res.status(403).json({ error: 'Administrator or HR access required' });
    }
    req.user = user;
    next();
  }

  async function requireAuth(req, res, next) {
    const user = await getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = user;
    next();
  }

  // A role can arrive from the dropdown or hand-typed through the API, so it is
  // matched case-insensitively and handed back in its canonical spelling —
  // otherwise "OPERATION" would silently be filed as the fallback role.
  const canonicalRoles = new Map([...allowedRoles].map((role) => [role.toLowerCase(), role]));
  canonicalRoles.set('admin', 'Administrator');
  canonicalRoles.set('operations', 'Operation');

  function normalizeRole(role, fallback = 'Trainee') {
    const value = String(role || fallback).trim() || fallback;
    if (value.toLowerCase() === 'staff') return fallback;
    return canonicalRoles.get(value.toLowerCase()) || fallback;
  }

  async function getActiveAdminCount() {
    const row = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE is_active = 1 AND role = 'Administrator'
    `).get();
    return Number(row?.count || 0);
  }

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    // Rate limit: max 10 attempts per IP per minute
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 60_000; }
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    if (attempt.count > 10) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
    }

    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
    if (!user || !isPasswordMatch(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Re-hash plain-text passwords on successful login
    if (user.password && !user.password.startsWith('$2')) {
      const rehashed = bcrypt.hashSync(password, 10);
      await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(rehashed, user.id);
    }

    const jti = require('crypto').randomBytes(16).toString('hex');
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, jti }, JWT_SECRET, { expiresIn: '8h' });
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
        daily_rate: user.daily_rate,
      },
    });
  });

  // POST /api/auth/register
  router.post('/register', requireAdmin, async (req, res) => {
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

    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const insert = db.prepare(`
      INSERT INTO users (username, password, full_name, role, birthday, address, phone_number, email_address, fb_account_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = await insert.run(username, hashedPassword, fullName, role, birthday || null, address || null, phoneNumber || null, emailAddress || null, fbAccountName || null);

    const user = await db.prepare('SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate FROM users WHERE id = ?').get(result.lastInsertRowid);
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
        daily_rate: user.daily_rate,
      },
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.jti) {
          const expiresAt = (payload.exp || 0) * 1000;
          tokenBlocklist.set(payload.jti, expiresAt || Date.now() + 8 * 60 * 60 * 1000);
        }
      } catch { /* token already invalid — nothing to revoke */ }
    }
    res.json({ message: 'Logged out successfully' });
  });

  // GET /api/auth/me
  router.get('/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.jti && tokenBlocklist.has(decoded.jti)) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
      const user = await db.prepare('SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate FROM users WHERE id=? AND is_active=1').get(decoded.id);
      if (!user) return res.status(401).json({ error: 'Account not found or deactivated' });
      res.json(user);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  router.put('/me', requireAuth, async (req, res) => {
    const userId = Number(req.user.id);
    const existing = await db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
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

    const usernameOwner = await db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, userId);
    if (usernameOwner) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const nextPassword = password ? bcrypt.hashSync(password, 10) : null;
    await db.prepare(`
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

    const user = await db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate
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
        daily_rate: user.daily_rate,
      },
    });
  });

  // Active accounts by default, so every existing caller is unchanged. HR asks
  // for 'inactive' or 'all' when it needs to reach someone who has left — their
  // attendance and any unpaid advance outlive the account.
  router.get('/users', requireAdmin, async (req, res) => {
    const status = String(req.query?.status || 'active').trim().toLowerCase();
    const where = status === 'inactive' ? 'WHERE is_active = 0'
      : status === 'all' ? ''
      : 'WHERE is_active = 1';
    const users = await db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate, is_active, created_at, updated_at
      FROM users
      ${where}
      ORDER BY
        CASE
          WHEN role = 'Administrator' THEN 0
          WHEN role = 'HR' THEN 1
          WHEN role = 'Operation' THEN 2
          WHEN role = 'CSR' THEN 3
          WHEN role = 'CSR TL' THEN 4
          WHEN role = 'Trainee' THEN 5
          WHEN role = 'RMO' THEN 6
          WHEN role = 'RMO TL' THEN 7
          WHEN role = 'Logistics' THEN 8
          WHEN role = 'Sales and Marketing' THEN 9
          WHEN role = 'Sales and Marketing TL' THEN 10
          ELSE 10
        END,
        full_name COLLATE NOCASE ASC,
        username COLLATE NOCASE ASC
    `).all();

    res.json({ users });
  });

  router.put('/users/:id', requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const existing = await db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
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

    const usernameOwner = await db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, userId);
    if (usernameOwner) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    if (existing.role === 'Administrator' && role !== 'Administrator' && (await getActiveAdminCount()) <= 1) {
      return res.status(400).json({ error: 'At least one active administrator account must remain' });
    }

    const nextPassword = password ? bcrypt.hashSync(password, 10) : null;
    await db.prepare(`
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

    const user = await db.prepare(`
      SELECT id, username, full_name, role, birthday, address, phone_number, email_address, fb_account_name, daily_rate, is_active, created_at, updated_at
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
        daily_rate: user.daily_rate,
      },
      meta: { is_active: user.is_active, created_at: user.created_at, updated_at: user.updated_at },
    });
  });


  // ─── POS CONFIRMER LINKS ─────────────────────────────────
  // Which dashboard account a POS confirmer is, so CSR Records can show a
  // member the orders they confirmed. The link is on the NAME, because that is
  // all pos_orders carries (confirmed_by_name) — a synced pos_users row is one
  // place a name can come from, not the source of truth. One name belongs to
  // one dashboard user; a person may hold several (an alias, a second login).
  // Edited on the Integrations page's POS Users tab, a row at a time.

  // Every name that has actually confirmed an order, with how many, merged with
  // the synced POS accounts (which carry the email/role/shop detail, and cover
  // someone who has a login but has not confirmed anything yet).
  router.get('/pos-accounts', requireAdmin, async (req, res) => {
    const confirmers = await db.prepare(`
      SELECT TRIM(confirmed_by_name) AS name, COUNT(*) AS orders
      FROM pos_orders
      WHERE confirmed_by_name IS NOT NULL AND TRIM(confirmed_by_name) <> ''
        AND COALESCE(status_name, '') <> 'wait_print'
      GROUP BY TRIM(confirmed_by_name)
    `).all();

    let posUsers = [];
    try {
      posUsers = await db.prepare(`
        SELECT external_key, shop_id, name, username, email, phone_number, role_name, is_active
        FROM pos_users
      `).all();
    } catch { posUsers = []; }

    const owners = await db.prepare(`
      SELECT l.pos_name, l.user_id, u.full_name
      FROM user_pos_links l
      LEFT JOIN users u ON u.id = l.user_id
    `).all();
    const ownerByName = new Map(owners.map((row) => [
      String(row.pos_name || '').trim().toLowerCase(),
      { id: row.user_id, name: row.full_name || `user ${row.user_id}` },
    ]));

    const byName = new Map();
    const add = (rawName, patch) => {
      const name = String(rawName || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      const existing = byName.get(key) || {
        name, orders: 0, external_key: '', shop_id: '', username: '',
        email: '', phone_number: '', role_name: '', is_active: true, synced: false,
      };
      byName.set(key, { ...existing, ...patch, name: existing.name || name });
    };

    for (const row of confirmers) add(row.name, { orders: Number(row.orders || 0) });
    for (const user of posUsers) {
      add(user.name || user.username || user.email, {
        external_key: user.external_key,
        shop_id: user.shop_id || '',
        username: user.username || '',
        email: user.email || '',
        phone_number: user.phone_number || '',
        role_name: user.role_name || '',
        is_active: Boolean(user.is_active),
        synced: true,
      });
    }

    const accounts = [...byName.values()]
      .map((account) => {
        const owner = ownerByName.get(account.name.toLowerCase());
        return { ...account, owner_id: owner?.id || null, owner_name: owner?.name || '' };
      })
      // Busiest confirmers first: the name being looked for is nearly always
      // one of them, and a long tail of one-order names would bury it.
      .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));

    res.json({ accounts });
  });

  // Assign one confirmer name to a dashboard user, or clear it with a null
  // user_id. A name held by somebody else is refused rather than moved: two
  // dashboard accounts on one name would both count its orders as their own.
  router.put('/pos-links', requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    const rawUserId = req.body?.user_id;
    if (rawUserId === null || rawUserId === '' || rawUserId === undefined) {
      await db.prepare('DELETE FROM user_pos_links WHERE LOWER(pos_name) = ?').run(name.toLowerCase());
      return res.json({ success: true, name, user_id: null });
    }

    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const user = await db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const owner = await db.prepare(`
      SELECT l.user_id, u.full_name
      FROM user_pos_links l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE LOWER(l.pos_name) = ? AND l.user_id <> ?
    `).get(name.toLowerCase(), userId);
    if (owner) {
      return res.status(409).json({
        error: `${name} is already assigned to ${owner.full_name || `user ${owner.user_id}`}`,
      });
    }

    // Keep the synced account alongside the name when there is one, so a later
    // rename in Pancake can be traced back to the account it came from.
    const account = await db.prepare(
      'SELECT external_key FROM pos_users WHERE LOWER(TRIM(name)) = ? LIMIT 1'
    ).get(name.toLowerCase());

    await db.prepare('DELETE FROM user_pos_links WHERE LOWER(pos_name) = ?').run(name.toLowerCase());
    await db.prepare(
      'INSERT INTO user_pos_links (pos_name, user_id, pos_external_key) VALUES (?, ?, ?)'
    ).run(name, userId, account?.external_key || null);

    res.json({ success: true, name, user_id: userId, user_name: user.full_name });
  });

  // Flip an account active or inactive. DELETE /users/:id already deactivates,
  // but it refuses to touch a row that is already inactive, so there was no way
  // back — a deactivated employee was stranded. requireAdmin covers
  // Administrator and HR, which is who may do this.
  router.patch('/users/:id/active', requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const active = req.body?.active ? 1 : 0;
    if (req.user.id === userId && !active) {
      return res.status(400).json({ error: 'You cannot deactivate your own account while signed in' });
    }

    const existing = await db.prepare('SELECT id, full_name, role, is_active FROM users WHERE id = ?').get(userId);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    if (!active && existing.is_active
      && existing.role === 'Administrator' && (await getActiveAdminCount()) <= 1) {
      return res.status(400).json({ error: 'At least one active administrator account must remain' });
    }

    await db.prepare(`
      UPDATE users
      SET is_active = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(active, userId);

    res.json({ success: true, id: userId, is_active: active, full_name: existing.full_name });
  });

  router.delete('/users/:id', requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (req.user.id === userId) {
      return res.status(400).json({ error: 'You cannot delete your own account while signed in' });
    }

    const existing = await db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(userId);
    if (!existing || !existing.is_active) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (existing.role === 'Administrator' && (await getActiveAdminCount()) <= 1) {
      return res.status(400).json({ error: 'At least one active administrator account must remain' });
    }

    await db.prepare(`
      UPDATE users
      SET is_active = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(userId);

    res.json({ success: true });
  });

  return router;
};
