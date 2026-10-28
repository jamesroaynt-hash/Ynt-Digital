const express = require('express');
const { departmentOf, isHrManager } = require('./performance');
const { posManilaDaySql } = require('../services/pancakePosSync');

// KPI Monitoring: HR's manual KPI records for CSR and RMO (schema in
// db/kpiMonitoringSchema.js). It replaces the old department KPI as the
// evaluation's KPI part (GET /scores).
//   CSR — orders (number of orders) and roas; higher is better. ROAS is
//     worked out from the two numbers HR types: gross sales ÷ ad spend.
//   RMO — rts (RTS rate, %); lower is better.
// HR enters every target and actual, daily and monthly separately. A CSR's
// Pancake confirmed orders (as CSR Records counts them) are offered as the
// orders actual for HR to accept; ROAS and RTS are never fetched. HR's,
// Operation's and the super admin's alone, the same gate as Performance.

const KPI_DEPARTMENT = { orders: 'CSR', roas: 'CSR', rts: 'RMO' };
const KPI_TYPES = Object.keys(KPI_DEPARTMENT);
const PERIOD_TYPES = ['daily', 'monthly'];
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// Built-in defaults when HR has not set one: RTS target 12%.
const BUILT_IN_DEFAULTS = { 'rts|daily': 12, 'rts|monthly': 12 };

function num(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function validPeriodKey(periodType, key) {
  return periodType === 'daily' ? DAY_PATTERN.test(key) : MONTH_PATTERN.test(key);
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

  function shape(row) {
    const target = row.target === null ? null : Number(row.target);
    const actual = row.actual === null ? null : Number(row.actual);
    return {
      id: Number(row.id),
      user_id: Number(row.user_id),
      department: row.department,
      kpi_type: row.kpi_type,
      period_type: row.period_type,
      period_key: row.period_key,
      target,
      actual,
      ad_spend: row.ad_spend === null || row.ad_spend === undefined ? null : Number(row.ad_spend),
      gross_sales: row.gross_sales === null || row.gross_sales === undefined ? null : Number(row.gross_sales),
      remarks: row.remarks || '',
      created_by: row.created_by_name || null,
      created_at: row.created_at,
      updated_by: row.updated_by_name || null,
      updated_at: row.updated_at,
      ...evaluate(row.kpi_type, target, actual),
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

  // Each CSR's Pancake confirmed orders for the day or month, counted exactly
  // as CSR Records → My Confirmed Orders counts them: orders whose confirmer
  // (pos_orders.confirmed_by_name) is one of the names linked to the account
  // in user_pos_links, widened by the staff_merge_map spellings of those
  // names; Awaiting print (wait_print) left out; filed under the order's
  // Manila day (posManilaDaySql). Only offered to HR as the orders actual.
  async function confirmedOrders(userIds, periodType, periodKey) {
    const out = new Map();
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
      out.set(Number(link.user_id), { total: 0, linked: true });
    }
    const userByFold = new Map([...ownerOf].map(([name, id]) => [fold(name), id]));
    for (const merge of merges) {
      for (const spelling of [merge.alias, merge.canonical]) {
        const value = String(spelling || '').trim();
        if (value && !ownerOf.has(value) && userByFold.has(fold(value))) ownerOf.set(value, userByFold.get(fold(value)));
      }
    }
    const names = [...ownerOf.keys()];
    const manilaDay = posManilaDaySql(db.type);
    const dayFilter = periodType === 'daily' ? `${manilaDay} = ?` : `${manilaDay} >= ? AND ${manilaDay} <= ?`;
    const dayArgs = periodType === 'daily' ? [periodKey] : [`${periodKey}-01`, `${periodKey}-31`];
    const rows = await db.prepare(`
      SELECT confirmed_by_name AS name, COUNT(*) AS n FROM pos_orders
      WHERE confirmed_by_name IN (${names.map(() => '?').join(', ')})
        AND COALESCE(status_name, '') <> 'wait_print' AND ${dayFilter}
      GROUP BY confirmed_by_name
    `).all(...names, ...dayArgs);
    for (const row of rows) {
      const id = ownerOf.get(String(row.name || '').trim());
      if (id && out.has(id)) out.get(id).total += Number(row.n || 0);
    }
    return out;
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
    const confirmedBy = await confirmedOrders(people.filter((p) => p.department === 'CSR').map((p) => p.id), periodType, periodKey);
    const byKey = new Map(records.map((r) => [`${r.user_id}|${r.kpi_type}`, shape(r)]));
    res.json({
      period_type: periodType,
      period_key: periodKey,
      defaults: defs,
      people: people.map((p) => ({
        ...p,
        kpis: Object.fromEntries(KPI_TYPES.filter((k) => KPI_DEPARTMENT[k] === p.department)
          .map((k) => [k, byKey.get(`${p.id}|${k}`) || null])),
        // linked: false = no Pancake confirmer name is linked to this account
        // (Integrations → POS Users), so there is nothing to count.
        ...(p.department === 'CSR' ? { confirmed_orders: confirmedBy.get(p.id) || { total: 0, linked: false } } : {}),
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
    res.json({ records: rows.map(shape) });
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
    let target = num(b.target);
    let actual = num(b.actual);
    // ROAS: HR types ad spend and gross sales; the actual is their ratio
    // (gross sales ÷ ad spend). No spend means no ROAS rather than a division
    // by zero.
    const adSpend = kpiType === 'roas' ? num(b.ad_spend) : null;
    const grossSales = kpiType === 'roas' ? num(b.gross_sales) : null;
    if (Number.isNaN(adSpend) || Number.isNaN(grossSales)) return res.status(400).json({ error: 'Ad spend and gross sales must be numbers' });
    if ((adSpend !== null && adSpend < 0) || (grossSales !== null && grossSales < 0)) return res.status(400).json({ error: 'Numbers cannot be negative' });
    if (kpiType === 'roas' && (adSpend !== null || grossSales !== null)) {
      actual = adSpend > 0 && grossSales !== null ? Math.round((grossSales / adSpend) * 100) / 100 : null;
    }
    if (Number.isNaN(target) || Number.isNaN(actual)) return res.status(400).json({ error: 'Target and actual must be numbers' });
    if ((target !== null && target < 0) || (actual !== null && actual < 0)) return res.status(400).json({ error: 'Numbers cannot be negative' });
    if (kpiType === 'rts' && ((target !== null && target > 100) || (actual !== null && actual > 100))) {
      return res.status(400).json({ error: 'RTS is a percentage (0–100)' });
    }
    if (kpiType === 'orders' && actual !== null && !Number.isInteger(actual)) return res.status(400).json({ error: 'Orders must be a whole number' });
    const remarks = String(b.remarks ?? '').trim().slice(0, 1000) || null;

    const person = await db.prepare('SELECT id, role, trainee_department, is_active FROM users WHERE id = ?').get(userId);
    if (!person || Number(person.is_active) !== 1) return res.status(400).json({ error: 'That employee is not active' });
    const department = departmentOf(person);
    if (department !== KPI_DEPARTMENT[kpiType]) {
      return res.status(400).json({ error: `${kpiType === 'rts' ? 'RTS Rate is an RMO KPI' : 'Orders and ROAS are CSR KPIs'}; this employee is in ${department}` });
    }
    if (b.department && b.department !== department) return res.status(400).json({ error: `This employee is in ${department}, not ${b.department}` });
    if (target === null) target = (await defaults())[`${kpiType}|${periodType}`] ?? null;

    const existing = await db.prepare(`SELECT * FROM kpi_records WHERE user_id = ? AND kpi_type = ? AND period_type = ? AND period_key = ?`)
      .get(userId, kpiType, periodType, periodKey);
    const actor = req.currentUser.id;
    if (existing) {
      const same = (x, y) => (x === null || x === undefined ? null : Number(x)) === (y === null || y === undefined ? null : Number(y));
      const changed = !same(existing.target, target) || !same(existing.actual, actual) || (existing.remarks || null) !== remarks
        || !same(existing.ad_spend, adSpend) || !same(existing.gross_sales, grossSales);
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
    res.json({ record: shape(saved) });
  }));

  // The evaluation's KPI part for a month: each CSR/RMO person's monthly
  // records scored out of 100 (target met = 100) and averaged. Same row shape
  // as the old /performance/kpi/scores (id, name, department, total).
  router.get('/scores', wrap(async (req, res) => {
    const period = MONTH_PATTERN.test(String(req.query.period || '')) ? req.query.period : null;
    if (!period) return res.status(400).json({ error: 'Pick a month (YYYY-MM)' });
    const [people, records] = await Promise.all([
      roster(),
      db.prepare(`${RECORD_SELECT} WHERE r.period_type = 'monthly' AND r.period_key = ?`).all(period),
    ]);
    const byUser = new Map();
    for (const r of records.map(shape)) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r);
    }
    res.json({
      period,
      rows: people.map((p) => {
        const kpis = (byUser.get(p.id) || []).filter((k) => k.score !== null);
        const total = kpis.length ? round1(kpis.reduce((sum, k) => sum + k.score, 0) / kpis.length) : null;
        return { ...p, kpis, total };
      }),
    });
  }));

  return router;
};

module.exports.evaluate = evaluate;
