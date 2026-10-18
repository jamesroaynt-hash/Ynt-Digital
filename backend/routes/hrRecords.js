const express = require('express');

// HR records: 201 files, HR calendar, onboarding, playbooks and KPI
// allowances. HR's, Operation's and the super admin's alone — the same gate as
// the rest of HR (routes/hr.js) — since contracts and memos are personnel files.
const HR_MANAGER_ROLES = new Set(['hr', 'operation', 'operations']);

function isHrManager(user) {
  if (Number(user?.is_super_admin) === 1) return true;
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

function text(value, max = 2000) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function date(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function json(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > 200000 ? null : raw;
}

// Each table is plain CRUD over a fixed column list. `clean` maps a request
// body to column values; `required` are the columns a row cannot be saved without.
const RESOURCES = {
  documents: {
    table: 'hr_documents',
    order: 'COALESCE(issue_date, \'\') DESC, id DESC',
    filters: { user_id: 'user_id', kind: 'kind' },
    required: ['user_id', 'doc_type'],
    clean: (b) => ({
      user_id: number(b.user_id),
      kind: b.kind === 'memo' ? 'memo' : 'document',
      doc_type: text(b.doc_type, 120),
      title: text(b.title, 300),
      status: text(b.status, 60),
      issue_date: date(b.issue_date),
      expiry_date: date(b.expiry_date),
      file_url: text(b.file_url, 1000),
      remarks: text(b.remarks),
    }),
  },
  calendar: {
    table: 'hr_calendar_events',
    order: 'event_date ASC, id ASC',
    filters: {},
    required: ['event_date', 'title'],
    clean: (b) => ({
      event_date: date(b.event_date),
      category: text(b.category, 60) || 'HR Task',
      title: text(b.title, 300),
      amount: number(b.amount),
      user_id: number(b.user_id),
      notes: text(b.notes),
      repeat_rule: ['none', 'weekly', 'monthly', 'cutoff', 'yearly'].includes(b.repeat_rule) ? b.repeat_rule : 'none',
      status: text(b.status, 30) || 'Upcoming',
    }),
  },
  trainees: {
    table: 'hr_trainees',
    order: 'COALESCE(start_date, \'\') DESC, id DESC',
    filters: {},
    required: ['full_name'],
    clean: (b) => ({
      full_name: text(b.full_name, 200),
      user_id: number(b.user_id),
      department: text(b.department, 60) || 'CSR',
      start_date: date(b.start_date),
      trainer: text(b.trainer, 200),
      stage: text(b.stage, 60),
      employee_code: text(b.employee_code, 60),
      status: text(b.status, 30) || 'In Training',
      progress: json(b.progress),
      remarks: text(b.remarks),
    }),
  },
  playbooks: {
    table: 'hr_playbooks',
    order: 'id ASC',
    filters: { scope: 'scope', user_id: 'user_id' },
    required: ['title'],
    clean: (b) => ({
      scope: b.scope === 'hr' ? 'hr' : 'employee',
      user_id: number(b.user_id),
      department: text(b.department, 60),
      title: text(b.title, 300),
      category: text(b.category, 60),
      link: text(b.link, 1000),
      description: text(b.description),
      progress: Math.max(0, Math.min(100, int(b.progress))),
      verified: b.verified ? 1 : 0,
    }),
  },
  'kpi-allowances': {
    table: 'hr_kpi_allowances',
    order: 'id DESC',
    filters: { user_id: 'user_id' },
    required: ['user_id', 'period_label'],
    clean: (b) => ({
      user_id: number(b.user_id),
      period_label: text(b.period_label, 60),
      kpi_score: number(b.kpi_score),
      amount: number(b.amount),
      status: text(b.status, 40) || 'Awaiting Evaluation',
      payroll_status: text(b.payroll_status, 40),
      remarks: text(b.remarks),
    }),
  },
};

const SETTING_KEYS = new Set(['kpi_allowance_tiers']);

module.exports = function hrRecordsRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((error) => {
    console.error('[hr-records]', error);
    res.status(500).json({ error: error.message || 'HR records request failed' });
  });

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare(
        'SELECT id, role, is_super_admin FROM users WHERE id = ? AND is_active = 1'
      ).get(req.user?.id);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      if (!isHrManager(user)) return res.status(403).json({ error: 'HR access required' });
      req.currentUser = user;
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  // The roster the 201 files hang off: every account, with the profile fields
  // that count toward 201 completeness and the birthday for the calendar.
  router.get('/people', wrap(async (req, res) => {
    const people = await db.prepare(`
      SELECT id, username, full_name, role, is_active, is_super_admin, birthday, address,
             phone_number, email_address, fb_account_name, daily_rate, day_off, created_at
      FROM users
      ORDER BY full_name COLLATE NOCASE ASC
    `).all();
    res.json({ people });
  }));

  router.get('/settings/:key', wrap(async (req, res) => {
    if (!SETTING_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown setting' });
    const row = await db.prepare('SELECT value FROM hr_settings WHERE key = ?').get(req.params.key);
    let value = null;
    try { value = row?.value ? JSON.parse(row.value) : null; } catch { value = null; }
    res.json({ key: req.params.key, value });
  }));

  router.put('/settings/:key', wrap(async (req, res) => {
    if (!SETTING_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown setting' });
    const value = json(req.body?.value);
    const existing = await db.prepare('SELECT key FROM hr_settings WHERE key = ?').get(req.params.key);
    if (existing) {
      await db.prepare("UPDATE hr_settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(value, req.params.key);
    } else {
      await db.prepare('INSERT INTO hr_settings (key, value) VALUES (?, ?)').run(req.params.key, value);
    }
    res.json({ key: req.params.key, value: req.body?.value ?? null });
  }));

  Object.entries(RESOURCES).forEach(([name, resource]) => {
    const { table } = resource;

    router.get(`/${name}`, wrap(async (req, res) => {
      const clauses = [];
      const params = [];
      Object.entries(resource.filters).forEach(([param, column]) => {
        const value = req.query?.[param];
        if (value === undefined || value === '') return;
        clauses.push(`${column} = ?`);
        params.push(column === 'user_id' ? Number(value) : String(value));
      });
      if (name === 'calendar') {
        // Repeating events are expanded on the page, so they come back whatever
        // the range; one-off events only inside it.
        const from = date(req.query?.from);
        const to = date(req.query?.to);
        if (from && to) {
          clauses.push("(repeat_rule <> 'none' OR event_date BETWEEN ? AND ?)");
          params.push(from, to);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${resource.order}`).all(...params);
      res.json({ rows });
    }));

    router.post(`/${name}`, wrap(async (req, res) => {
      const values = resource.clean(req.body || {});
      const missing = resource.required.filter((column) => values[column] === null || values[column] === undefined);
      if (missing.length) return res.status(400).json({ error: `Missing ${missing.join(', ').replace(/_/g, ' ')}` });
      const columns = Object.keys(values);
      const result = await db.prepare(`
        INSERT INTO ${table} (${columns.join(', ')}, created_by)
        VALUES (${columns.map(() => '?').join(', ')}, ?)
      `).run(...columns.map((column) => values[column]), req.currentUser.id);
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
      res.status(201).json({ row });
    }));

    // A partial update: only the fields sent are touched, so the onboarding
    // checklist can save its progress without resending the whole trainee.
    router.put(`/${name}/:id`, wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!existing) return res.status(404).json({ error: 'Record not found' });
      const body = req.body || {};
      const merged = { ...existing, ...body };
      const values = resource.clean(merged);
      const columns = Object.keys(values).filter((column) => Object.prototype.hasOwnProperty.call(body, column));
      const missing = resource.required.filter((column) => values[column] === null || values[column] === undefined);
      if (missing.length) return res.status(400).json({ error: `Missing ${missing.join(', ').replace(/_/g, ' ')}` });
      if (columns.length) {
        await db.prepare(`
          UPDATE ${table}
          SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = datetime('now')
          WHERE id = ?
        `).run(...columns.map((column) => values[column]), id);
      }
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      res.json({ row });
    }));

    router.delete(`/${name}/:id`, wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
      await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      res.json({ ok: true });
    }));
  });

  return router;
};
