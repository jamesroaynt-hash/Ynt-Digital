const express = require('express');
const { departmentOf, isHrManager } = require('./performance');
const { posManilaDaySql } = require('../services/pancakePosSync');

// KPI Monitoring: HR's manual KPI records for CSR and RMO (schema in
// db/kpiMonitoringSchema.js). It replaces the old department KPI as the
// evaluation's KPI part (GET /scores).
//   CSR — orders and roas; higher is better.
//   RMO — rts (RTS rate, %); lower is better.
// Daily and monthly are separate. For CSR the numbers fill in by themselves
// and HR overrides any of them by hand (a saved kpi_records value always
// wins; clearing it goes back to the automatic one):
//   orders target = the team orders target (kpi_team_targets) ÷ active CSRs
//   orders actual = their Pancake confirmed orders, as CSR Records counts them
//   gross sales   = the COD total of those confirmed orders
//   ROAS          = gross sales ÷ the CSR team's ad spend (kpi_ad_spend, one
//                   amount a day for all CSRs; a month is the sum of its days)
// Everything is worked out on read (effective()), so the cards, History and
// the evaluation's KPI part all follow the latest numbers. RMO RTS and every
// target fallback (kpi_defaults) are HR's alone. HR's, Operation's and the
// super admin's only, the same gate as Performance.

const KPI_DEPARTMENT = { orders: 'CSR', roas: 'CSR', rts: 'RMO' };
const KPI_TYPES = Object.keys(KPI_DEPARTMENT);
// 'half' is the Evaluation's half month: YYYY-MM-H1 (1st–15th) or -H2
// (16th to the end); it has its own records like a day or a month does.
const PERIOD_TYPES = ['daily', 'monthly', 'half'];
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const HALF_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-H[12]$/;
// Built-in defaults when HR has not set one: RTS target 12%.
const BUILT_IN_DEFAULTS = { 'rts|daily': 12, 'rts|monthly': 12, 'rts|half': 12 };

function num(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function validPeriodKey(periodType, key) {
  if (periodType === 'daily') return DAY_PATTERN.test(key);
  if (periodType === 'half') return HALF_PATTERN.test(key);
  return MONTH_PATTERN.test(key);
}

// First and last day (YYYY-MM-DD) a period covers; '-31' is safe as an upper
// bound for every month because the days are compared as text.
function periodDays(periodType, key) {
  if (periodType === 'daily') return [key, key];
  if (periodType === 'half') {
    const month = key.slice(0, 7);
    return key.endsWith('H1') ? [`${month}-01`, `${month}-15`] : [`${month}-16`, `${month}-31`];
  }
  return [`${key}-01`, `${key}-31`];
}

// Achievement and status, worked out on read so they always follow the
// numbers. Zero or missing targets never divide.
function evaluate(kpiType, target, actual) {
  const t = target === null || target === undefined ? null : Number(target);
  const a = actual === null || actual === undefined ? null : Number(actual);
  if (a === null) return { achievement: null, status: 'no_data', score: null };
  if (kpiType === 'rts') {
    if (t === null) return { achievement: null, status: 'no_target', score: null };
    const meeting = a <= t;
    return {
      achievement: null,
      status: meeting ? 'meeting' : 'above',
      // Score out of 100 for the evaluation: at or under target is 100.
      score: meeting ? 100 : (a > 0 ? round1((t / a) * 100) : 100),
    };
  }
  if (!(t > 0)) return { achievement: null, status: 'no_target', score: null };
  const achievement = round1((a / t) * 100);
  return { achievement, status: a >= t ? 'meeting' : 'below', score: Math.min(100, achievement) };
}

module.exports = function kpiMonitoringRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((error) => {
    console.error('[kpi-monitoring]', error);
    res.status(500).json({ error: error.message || 'KPI request failed' });
  });

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare('SELECT id, role, is_super_admin FROM users WHERE id = ? AND is_active = 1').get(req.user?.id);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      if (!isHrManager(user)) return res.status(403).json({ error: 'HR access required' });
      req.currentUser = user;
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Active CSR and RMO people (trainees placed in either count too).
  async function roster() {
    const users = await db.prepare(`
      SELECT id, full_name, username, role, trainee_department
      FROM users WHERE is_active = 1 AND COALESCE(is_super_admin, 0) = 0
      ORDER BY full_name
    `).all();
    return users
      .map((u) => ({ id: Number(u.id), name: u.full_name || u.username || `User ${u.id}`, department: departmentOf(u) }))
      .filter((u) => u.department === 'CSR' || u.department === 'RMO');
  }

  async function defaults() {
    const rows = await db.prepare('SELECT kpi_type, period_type, target FROM kpi_defaults').all();
    const out = { ...BUILT_IN_DEFAULTS };
    for (const r of rows) out[`${r.kpi_type}|${r.period_type}`] = r.target === null ? null : Number(r.target);
    const result = {};
    for (const kpi of KPI_TYPES) {
      for (const period of PERIOD_TYPES) result[`${kpi}|${period}`] = out[`${kpi}|${period}`] ?? null;
    }
    return result;
  }

  const RECORD_SELECT = `
    SELECT r.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
    FROM kpi_records r
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users uu ON uu.id = r.updated_by`;

  const val = (v) => (v === null || v === undefined ? null : Number(v));
  const round2 = (v) => Math.round(v * 100) / 100;

  // One KPI as it stands: HR's saved value where there is one, otherwise the
  // automatic one; *_source says which ('manual', or where it came from).
  // row: the kpi_records row (or undefined); ctx: periodContext().
  function effective(person, kpiType, row, ctx) {
    const confirmed = ctx.confirmed.get(person.id) || null;
    const linked = !!confirmed?.linked;
    const saved = { target: val(row?.target), actual: val(row?.actual), gross_sales: val(row?.gross_sales) };
    let target = saved.target;
    let targetSource = target === null ? null : 'manual';
    if (target === null && kpiType === 'orders' && ctx.teamShare !== null) { target = ctx.teamShare; targetSource = 'team'; }
    if (target === null && ctx.defaults[`${kpiType}|${ctx.periodType}`] !== null && ctx.defaults[`${kpiType}|${ctx.periodType}`] !== undefined) {
      target = ctx.defaults[`${kpiType}|${ctx.periodType}`];
      targetSource = 'default';
    }
    let actual = saved.actual;
    let actualSource = actual === null ? null : 'manual';
    let grossSales = null;
    let grossSource = null;
    let adSpend = null;
    if (kpiType === 'orders' && actual === null && linked) { actual = confirmed.total; actualSource = 'confirmed'; }
    if (kpiType === 'roas') {
      grossSales = saved.gross_sales;
      grossSource = grossSales === null ? null : 'manual';
      if (grossSales === null && linked) { grossSales = confirmed.cod; grossSource = 'confirmed'; }
      adSpend = ctx.spend.total;
      actual = grossSales !== null && adSpend > 0 ? round2(grossSales / adSpend) : null;
      actualSource = actual === null ? null : 'calculated';
    }
    return {
      id: row ? Number(row.id) : null,
      user_id: person.id,
      department: person.department,
      kpi_type: kpiType,
      period_type: ctx.periodType,
      period_key: ctx.periodKey,
      target,
      target_source: targetSource,
      actual,
      actual_source: actualSource,
      ...(kpiType === 'roas' ? { gross_sales: grossSales, gross_source: grossSource, ad_spend: adSpend } : {}),
      saved,
      remarks: row?.remarks || '',
      created_by: row?.created_by_name || null,
      created_at: row?.created_at || null,
      updated_by: row?.updated_by_name || null,
      updated_at: row?.updated_at || null,
      ...evaluate(kpiType, target, actual),
    };
  }

  router.get('/defaults', wrap(async (req, res) => {
    res.json({ defaults: await defaults() });
  }));

  router.put('/defaults', wrap(async (req, res) => {
    const kpiType = String(req.body?.kpi_type || '');
    const periodType = String(req.body?.period_type || '');
    const target = num(req.body?.target);
    if (!KPI_TYPES.includes(kpiType) || !PERIOD_TYPES.includes(periodType)) return res.status(400).json({ error: 'Unknown KPI or period' });
    if (Number.isNaN(target) || (target !== null && target < 0)) return res.status(400).json({ error: 'Target must be a number of 0 or more' });
    if (kpiType === 'rts' && target !== null && target > 100) return res.status(400).json({ error: 'RTS target is a percentage (0–100)' });
    await db.prepare(`
      INSERT INTO kpi_defaults (kpi_type, period_type, target, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (kpi_type, period_type) DO UPDATE SET target = excluded.target, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `).run(kpiType, periodType, target, req.currentUser.id);
    res.json({ defaults: await defaults() });
  }));

  // The CSR team's ad spend for a day, or the days of a half or month added up.
  async function teamAdSpend(periodType, periodKey) {
    const row = await db.prepare('SELECT SUM(amount) AS total, COUNT(amount) AS days FROM kpi_ad_spend WHERE work_date >= ? AND work_date <= ?')
      .get(...periodDays(periodType, periodKey));
    const days = Number(row?.days || 0);
    return { total: days ? Number(row.total) : null, days };
  }

  // HR sets the team's ad spend for one day; every change is kept.
  router.put('/ad-spend', wrap(async (req, res) => {
    const date = String(req.body?.date || '');
    const amount = num(req.body?.amount);
    if (!DAY_PATTERN.test(date)) return res.status(400).json({ error: 'Pick a day' });
    if (Number.isNaN(amount) || (amount !== null && amount < 0)) return res.status(400).json({ error: 'Ad spend must be a number of 0 or more' });
    const existing = await db.prepare('SELECT amount FROM kpi_ad_spend WHERE work_date = ?').get(date);
    const old = existing ? (existing.amount === null ? null : Number(existing.amount)) : null;
    if (!existing || old !== amount) {
      await db.prepare(`
        INSERT INTO kpi_ad_spend (work_date, amount, updated_by) VALUES (?, ?, ?)
        ON CONFLICT (work_date) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
      `).run(date, amount, req.currentUser.id);
      await db.prepare('INSERT INTO kpi_ad_spend_history (work_date, old_amount, new_amount, changed_by) VALUES (?, ?, ?, ?)')
        .run(date, old, amount, req.currentUser.id);
    }
    res.json({ date, ad_spend: await teamAdSpend('daily', date), month: await teamAdSpend('monthly', date.slice(0, 7)) });
  }));

  router.get('/ad-spend/history', wrap(async (req, res) => {
    const month = String(req.query.month || '');
    if (!MONTH_PATTERN.test(month)) return res.status(400).json({ error: 'Pick a month' });
    const rows = await db.prepare(`
      SELECT h.*, u.full_name AS changed_by_name FROM kpi_ad_spend_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.work_date >= ? AND h.work_date <= ? ORDER BY h.id DESC
    `).all(`${month}-01`, `${month}-31`);
    res.json({ history: rows.map((h) => ({ date: h.work_date, old_amount: h.old_amount, new_amount: h.new_amount, changed_by: h.changed_by_name || null, changed_at: h.changed_at })) });
  }));

  async function teamTarget(kpiType, periodType, periodKey) {
    const row = await db.prepare('SELECT target FROM kpi_team_targets WHERE kpi_type = ? AND period_type = ? AND period_key = ?')
      .get(kpiType, periodType, periodKey);
    return val(row?.target);
  }

  // HR sets the CSR team's orders target for a day or a month.
  router.put('/team-target', wrap(async (req, res) => {
    const periodType = String(req.body?.period_type || '');
    const periodKey = String(req.body?.period_key || '');
    const target = num(req.body?.target);
    if (!PERIOD_TYPES.includes(periodType) || !validPeriodKey(periodType, periodKey)) return res.status(400).json({ error: 'Pick a day, a half month or a month' });
    if (Number.isNaN(target) || (target !== null && target < 0)) return res.status(400).json({ error: 'Target must be a number of 0 or more' });
    const old = await teamTarget('orders', periodType, periodKey);
    if (old !== target) {
      await db.prepare(`
        INSERT INTO kpi_team_targets (kpi_type, period_type, period_key, target, updated_by) VALUES ('orders', ?, ?, ?, ?)
        ON CONFLICT (kpi_type, period_type, period_key) DO UPDATE SET target = excluded.target, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
      `).run(periodType, periodKey, target, req.currentUser.id);
      await db.prepare(`INSERT INTO kpi_team_target_history (kpi_type, period_type, period_key, old_target, new_target, changed_by)
        VALUES ('orders', ?, ?, ?, ?, ?)`).run(periodType, periodKey, old, target, req.currentUser.id);
    }
    res.json({ period_type: periodType, period_key: periodKey, target });
  }));

  // Everything effective() needs for one period.
  async function periodContext(people, periodType, periodKey, csrIds) {
    const csrCount = people.filter((p) => p.department === 'CSR').length;
    const [confirmed, spend, team, defs] = await Promise.all([
      confirmedOrders(csrIds ?? people.filter((p) => p.department === 'CSR').map((p) => p.id), periodType, periodKey),
      teamAdSpend(periodType, periodKey),
      teamTarget('orders', periodType, periodKey),
      defaults(),
    ]);
    return {
      periodType, periodKey, confirmed, spend, defaults: defs,
      team: { orders_target: team, csr_count: csrCount },
      teamShare: team !== null && csrCount > 0 ? round2(team / csrCount) : null,
    };
  }

  // Each CSR's Pancake confirmed orders for the day or month, counted exactly
  // as CSR Records → My Confirmed Orders counts them: orders whose confirmer
  // (pos_orders.confirmed_by_name) is one of the names linked to the account
  // in user_pos_links, widened by the staff_merge_map spellings of those
  // names; Awaiting print (wait_print) left out; filed under the order's
  // Manila day (posManilaDaySql). Only offered to HR: the count as the orders
  // actual, their COD total as the gross sales.
  async function confirmedOrders(userIds, periodType, periodKey) {
    const out = new Map();
    out.spellings = new Set(); // every confirmer spelling counted for these users
    if (!userIds.length) return out;
    const placeholders = userIds.map(() => '?').join(', ');
    const links = await db.prepare(`SELECT user_id, pos_name FROM user_pos_links WHERE user_id IN (${placeholders})`).all(...userIds);
    if (!links.length) return out;
    let merges = [];
    try { merges = await db.prepare('SELECT alias, canonical FROM staff_merge_map').all(); } catch { merges = []; }
    const byAlias = new Map(merges.map((m) => [String(m.alias || '').trim().toLowerCase(), String(m.canonical || '').trim()]));
    const fold = (name) => {
      let cur = String(name || '').trim();
      const seen = new Set();
      while (byAlias.get(cur.toLowerCase()) && !seen.has(cur.toLowerCase())) {
        seen.add(cur.toLowerCase());
        cur = byAlias.get(cur.toLowerCase());
      }
      return cur.toLowerCase();
    };
    // Every spelling that folds to a linked name belongs to that user.
    const ownerOf = new Map(); // spelling → user id
    for (const link of links) {
      const name = String(link.pos_name || '').trim();
      if (name) ownerOf.set(name, Number(link.user_id));
      out.set(Number(link.user_id), { total: 0, cod: 0, linked: true });
    }
    const userByFold = new Map([...ownerOf].map(([name, id]) => [fold(name), id]));
    for (const merge of merges) {
      for (const spelling of [merge.alias, merge.canonical]) {
        const value = String(spelling || '').trim();
        if (value && !ownerOf.has(value) && userByFold.has(fold(value))) ownerOf.set(value, userByFold.get(fold(value)));
      }
    }
    const names = [...ownerOf.keys()];
    names.forEach((name) => out.spellings.add(name));
    const manilaDay = posManilaDaySql(db.type);
    const dayFilter = periodType === 'daily' ? `${manilaDay} = ?` : `${manilaDay} >= ? AND ${manilaDay} <= ?`;
    const dayArgs = periodType === 'daily' ? [periodKey] : periodDays(periodType, periodKey);
    const rows = await db.prepare(`
      SELECT confirmed_by_name AS name, COUNT(*) AS n, COALESCE(SUM(cod), 0) AS cod FROM pos_orders
      WHERE confirmed_by_name IN (${names.map(() => '?').join(', ')})
        AND COALESCE(status_name, '') <> 'wait_print' AND ${dayFilter}
      GROUP BY confirmed_by_name
    `).all(...names, ...dayArgs);
    for (const row of rows) {
      const id = ownerOf.get(String(row.name || '').trim());
      if (id && out.has(id)) {
        out.get(id).total += Number(row.n || 0);
        out.get(id).cod = Math.round((out.get(id).cod + Number(row.cod || 0)) * 100) / 100;
      }
    }
    return out;
  }

  // Orders confirmed in the period by people who are not active CSRs (admins,
  // TLs, an unlinked Pancake name): one "Others" line under the CSR table, so
  // the team's totals cover every confirmed sale. Named confirmers only, same
  // rules as the CSR count; a name linked to a dashboard account shows that
  // account's name.
  async function otherConfirmers(periodType, periodKey, csrSpellings) {
    const manilaDay = posManilaDaySql(db.type);
    const dayFilter = periodType === 'daily' ? `${manilaDay} = ?` : `${manilaDay} >= ? AND ${manilaDay} <= ?`;
    const dayArgs = periodType === 'daily' ? [periodKey] : periodDays(periodType, periodKey);
    const [rows, links] = await Promise.all([
      db.prepare(`
        SELECT confirmed_by_name AS name, COUNT(*) AS n, COALESCE(SUM(cod), 0) AS cod FROM pos_orders
        WHERE confirmed_by_name IS NOT NULL AND TRIM(confirmed_by_name) <> ''
          AND COALESCE(status_name, '') <> 'wait_print' AND ${dayFilter}
        GROUP BY confirmed_by_name
      `).all(...dayArgs),
      db.prepare('SELECT l.pos_name, u.full_name FROM user_pos_links l JOIN users u ON u.id = l.user_id').all(),
    ]);
    const display = new Map(links.map((l) => [String(l.pos_name || '').trim().toLowerCase(), l.full_name]));
    const byName = new Map();
    for (const row of rows) {
      const raw = String(row.name || '').trim();
      if (!raw || csrSpellings.has(raw)) continue;
      const name = display.get(raw.toLowerCase()) || raw;
      const entry = byName.get(name) || { name, orders: 0, cod: 0 };
      entry.orders += Number(row.n || 0);
      entry.cod = round2(entry.cod + Number(row.cod || 0));
      byName.set(name, entry);
    }
    const people = [...byName.values()].sort((a, b) => b.orders - a.orders);
    return {
      total: people.reduce((sum, p) => sum + p.orders, 0),
      cod: round2(people.reduce((sum, p) => sum + p.cod, 0)),
      people,
    };
  }

  // Everyone in CSR and RMO for one period, with whatever HR has entered.
  router.get('/records', wrap(async (req, res) => {
    const periodType = PERIOD_TYPES.includes(req.query.period_type) ? req.query.period_type : 'monthly';
    const periodKey = String(req.query.period_key || '');
    if (!validPeriodKey(periodType, periodKey)) return res.status(400).json({ error: 'Pick a valid day or month' });
    const [people, records, defs] = await Promise.all([
      roster(),
      db.prepare(`${RECORD_SELECT} WHERE r.period_type = ? AND r.period_key = ?`).all(periodType, periodKey),
      defaults(),
    ]);
    const ctx = await periodContext(people, periodType, periodKey);
    const rowBy = new Map(records.map((r) => [`${r.user_id}|${r.kpi_type}`, r]));
    const confirmedBy = ctx.confirmed;
    res.json({
      period_type: periodType,
      period_key: periodKey,
      defaults: defs,
      team_ad_spend: ctx.spend,
      team: { ...ctx.team, share: ctx.teamShare },
      others: await otherConfirmers(periodType, periodKey, ctx.confirmed.spellings),
      people: people.map((p) => ({
        ...p,
        kpis: Object.fromEntries(KPI_TYPES.filter((k) => KPI_DEPARTMENT[k] === p.department)
          .map((k) => [k, effective(p, k, rowBy.get(`${p.id}|${k}`), ctx)])),
        // linked: false = no Pancake confirmer name is linked to this account
        // (Integrations → POS Users), so there is nothing to count.
        ...(p.department === 'CSR' ? { confirmed_orders: confirmedBy.get(p.id) || { total: 0, cod: 0, linked: false } } : {}),
      })),
    });
  }));

  // One person's past records (newest first), for the history view.
  router.get('/records/history', wrap(async (req, res) => {
    const userId = Number(req.query.user_id);
    const periodType = PERIOD_TYPES.includes(req.query.period_type) ? req.query.period_type : 'monthly';
    if (!userId) return res.status(400).json({ error: 'Pick an employee' });
    const rows = await db.prepare(`${RECORD_SELECT} WHERE r.user_id = ? AND r.period_type = ? ORDER BY r.period_key DESC, r.kpi_type`)
      .all(userId, periodType);
    const people = await roster();
    const person = people.find((p) => p.id === userId) || { id: userId, department: KPI_DEPARTMENT[rows[0]?.kpi_type] || 'CSR' };
    const ctxBy = new Map();
    const out = [];
    for (const row of rows) {
      if (!ctxBy.has(row.period_key)) ctxBy.set(row.period_key, await periodContext(people, periodType, row.period_key, [userId]));
      out.push(effective(person, row.kpi_type, row, ctxBy.get(row.period_key)));
    }
    res.json({ records: out });
  }));

  // Every change to one record, oldest first.
  router.get('/records/:id/audit', wrap(async (req, res) => {
    const rows = await db.prepare(`
      SELECT h.*, u.full_name AS changed_by_name FROM kpi_record_history h
      LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.record_id = ? ORDER BY h.id
    `).all(Number(req.params.id));
    res.json({
      audit: rows.map((h) => ({
        action: h.action,
        old_target: h.old_target, old_actual: h.old_actual, old_remarks: h.old_remarks || '',
        new_target: h.new_target, new_actual: h.new_actual, new_remarks: h.new_remarks || '',
        old_ad_spend: h.old_ad_spend ?? null, old_gross_sales: h.old_gross_sales ?? null,
        new_ad_spend: h.new_ad_spend ?? null, new_gross_sales: h.new_gross_sales ?? null,
        changed_by: h.changed_by_name || null,
        changed_at: h.changed_at,
      })),
    });
  }));

  // Create or correct one record. The key (employee, KPI, period type,
  // period) is unique, so saving again edits the same row; each save that
  // changes something adds a history row with the before and after values.
  router.put('/records', wrap(async (req, res) => {
    const b = req.body || {};
    const userId = Number(b.user_id);
    const kpiType = String(b.kpi_type || '');
    const periodType = String(b.period_type || '');
    const periodKey = String(b.period_key || '');
    if (!userId) return res.status(400).json({ error: 'Pick an employee' });
    if (!KPI_TYPES.includes(kpiType)) return res.status(400).json({ error: 'Pick a KPI: Number of Orders, ROAS or RTS Rate' });
    if (!PERIOD_TYPES.includes(periodType) || !validPeriodKey(periodType, periodKey)) {
      return res.status(400).json({ error: 'Pick Daily with a day, or Monthly with a month' });
    }
    // Only the fields sent change; a field sent empty clears HR's value and
    // the automatic one shows again. Nothing automatic is stored here.
    const has = (key) => Object.prototype.hasOwnProperty.call(b, key);
    const incoming = { target: num(b.target), actual: num(b.actual), gross_sales: num(b.gross_sales) };
    if (Object.values(incoming).some(Number.isNaN)) return res.status(400).json({ error: 'Numbers only, please' });
    if (Object.values(incoming).some((v) => v !== null && v < 0)) return res.status(400).json({ error: 'Numbers cannot be negative' });
    if (kpiType === 'rts' && ((incoming.target ?? 0) > 100 || (incoming.actual ?? 0) > 100)) {
      return res.status(400).json({ error: 'RTS is a percentage (0–100)' });
    }
    if (kpiType === 'orders' && incoming.actual !== null && !Number.isInteger(incoming.actual)) return res.status(400).json({ error: 'Orders must be a whole number' });
    if (kpiType === 'roas' && has('actual') && incoming.actual !== null) return res.status(400).json({ error: 'ROAS is worked out from gross sales ÷ team ad spend' });
    const remarksIn = String(b.remarks ?? '').trim().slice(0, 1000) || null;

    const person = await db.prepare('SELECT id, role, trainee_department, is_active FROM users WHERE id = ?').get(userId);
    if (!person || Number(person.is_active) !== 1) return res.status(400).json({ error: 'That employee is not active' });
    const department = departmentOf(person);
    if (department !== KPI_DEPARTMENT[kpiType]) {
      return res.status(400).json({ error: `${kpiType === 'rts' ? 'RTS Rate is an RMO KPI' : 'Orders and ROAS are CSR KPIs'}; this employee is in ${department}` });
    }
    if (b.department && b.department !== department) return res.status(400).json({ error: `This employee is in ${department}, not ${b.department}` });

    const existing = await db.prepare(`SELECT * FROM kpi_records WHERE user_id = ? AND kpi_type = ? AND period_type = ? AND period_key = ?`)
      .get(userId, kpiType, periodType, periodKey);
    const pick = (key) => (has(key) ? incoming[key] : val(existing?.[key]));
    const target = pick('target');
    const actual = kpiType === 'roas' ? null : pick('actual');
    const grossSales = kpiType === 'roas' ? pick('gross_sales') : null;
    const remarks = has('remarks') ? remarksIn : (existing?.remarks || null);
    // The team's ad spend at the time is kept with the record for the trail.
    const adSpend = kpiType === 'roas' ? (await teamAdSpend(periodType, periodKey)).total : null;
    const actor = req.currentUser.id;
    if (existing) {
      const same = (x, y) => val(x) === val(y);
      const changed = !same(existing.target, target) || !same(existing.actual, actual) || (existing.remarks || null) !== remarks
        || !same(existing.gross_sales, grossSales);
      if (changed) {
        await db.prepare(`UPDATE kpi_records SET target = ?, actual = ?, ad_spend = ?, gross_sales = ?, remarks = ?, department = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(target, actual, adSpend, grossSales, remarks, department, actor, existing.id);
        await db.prepare(`
          INSERT INTO kpi_record_history (record_id, action, old_target, old_actual, old_remarks, old_ad_spend, old_gross_sales,
            new_target, new_actual, new_remarks, new_ad_spend, new_gross_sales, changed_by)
          VALUES (?, 'update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(existing.id, existing.target, existing.actual, existing.remarks, existing.ad_spend ?? null, existing.gross_sales ?? null,
          target, actual, remarks, adSpend, grossSales, actor);
      }
    } else {
      await db.prepare(`
        INSERT INTO kpi_records (user_id, department, kpi_type, period_type, period_key, target, actual, ad_spend, gross_sales, remarks, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, kpi_type, period_type, period_key) DO NOTHING
      `).run(userId, department, kpiType, periodType, periodKey, target, actual, adSpend, grossSales, remarks, actor, actor);
      const created = await db.prepare(`SELECT id FROM kpi_records WHERE user_id = ? AND kpi_type = ? AND period_type = ? AND period_key = ?`)
        .get(userId, kpiType, periodType, periodKey);
      await db.prepare(`
        INSERT INTO kpi_record_history (record_id, action, new_target, new_actual, new_remarks, new_ad_spend, new_gross_sales, changed_by)
        VALUES (?, 'create', ?, ?, ?, ?, ?, ?)
      `).run(created.id, target, actual, remarks, adSpend, grossSales, actor);
    }
    const saved = await db.prepare(`${RECORD_SELECT} WHERE r.user_id = ? AND r.kpi_type = ? AND r.period_type = ? AND r.period_key = ?`)
      .get(userId, kpiType, periodType, periodKey);
    const people = await roster();
    const me = people.find((p) => p.id === userId) || { id: userId, department };
    const ctx = await periodContext(people, periodType, periodKey, [userId]);
    res.json({ record: effective(me, kpiType, saved, ctx) });
  }));

  // The evaluation's KPI part for a month: each CSR/RMO person's monthly
  // KPIs as they stand (HR's values, else the automatic ones) scored out of
  // 100 (target met = 100) and averaged. Same row shape
  // as the old /performance/kpi/scores (id, name, department, total).
  router.get('/scores', wrap(async (req, res) => {
    const period = MONTH_PATTERN.test(String(req.query.period || '')) ? req.query.period : null;
    if (!period) return res.status(400).json({ error: 'Pick a month (YYYY-MM)' });
    const [people, records] = await Promise.all([
      roster(),
      db.prepare(`${RECORD_SELECT} WHERE r.period_type = 'monthly' AND r.period_key = ?`).all(period),
    ]);
    const ctx = await periodContext(people, 'monthly', period);
    const rowBy = new Map(records.map((r) => [`${r.user_id}|${r.kpi_type}`, r]));
    res.json({
      period,
      rows: people.map((p) => {
        const kpis = KPI_TYPES.filter((k) => KPI_DEPARTMENT[k] === p.department)
          .map((k) => effective(p, k, rowBy.get(`${p.id}|${k}`), ctx))
          .filter((k) => k.score !== null);
        const total = kpis.length ? round1(kpis.reduce((sum, k) => sum + k.score, 0) / kpis.length) : null;
        return { ...p, kpis, total };
      }),
    });
  }));

  return router;
};

module.exports.evaluate = evaluate;
