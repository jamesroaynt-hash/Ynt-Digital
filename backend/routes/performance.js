const express = require('express');

// Performance: Employee Tracker marks, and the two scoring categories that sit
// beside the peer Evaluation without touching it —
//   Compliance (Category 2): worked out from the tracker marks (Standup, EOD,
//     Self-Care, WAM) and Time & Attendance, per 15-day period.
//   KPI (Category 3): department KPI templates with per-person tweaks; HR
//     enters each person's actual number per month (ad budget and ROAS run
//     monthly). A ratio such as ROAS is just a KPI with its target, e.g. 3.
// HR's, Operation's and the super admin's alone — the same gate as the rest of
// HR (routes/hr.js, routes/hrRecords.js).
const HR_MANAGER_ROLES = new Set(['hr', 'operation', 'operations']);

function isHrManager(user) {
  if (Number(user?.is_super_admin) === 1) return true;
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

const TRACKER_METRICS = new Set(['standup', 'eod', 'selfcare', 'wam', 'discordlive']);
const TRACKER_STATES = new Set(['yes', 'late', 'rest', 'no']);
// What Compliance scores; Discord Live is tracked but not part of the score.
const COMPLIANCE_METRICS = ['attendance', 'standup', 'eod', 'selfcare', 'wam'];
// A late counts half: they showed up, but not on time.
const STATE_CREDIT = { yes: 1, late: 0.5, no: 0 };

// Same role → department mapping as the Employee Tracker (DEPARTMENT_BY_ROLE in
// app.js), so a department's KPI template lands on the people the tracker
// groups under it.
const DEPARTMENT_BY_ROLE = {
  administrator: 'Management',
  hr: 'Human Resources',
  operation: 'Operations',
  operations: 'Operations',
  'sales and marketing': 'Sales & Marketing',
  'sales and marketing tl': 'Sales & Marketing',
  csr: 'CSR',
  'csr tl': 'CSR',
  rmo: 'RMO',
  'rmo tl': 'RMO',
  logistics: 'Logistics',
  trainee: 'Trainee',
};
const TRAINEE_DEPARTMENTS = new Set(['CSR', 'RMO', 'Logistics', 'Sales & Marketing', 'Human Resources', 'Operations']);
const DEPARTMENTS = ['Management', 'Human Resources', 'Operations', 'Sales & Marketing', 'CSR', 'RMO', 'Logistics', 'Trainee'];

function departmentOf(user) {
  // navAccessKey() in app.js, plus its admin → Administrator alias.
  let key = String(user?.role || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[\s_-]+/g, ' ');
  if (key === 'admin') key = 'administrator';
  const department = DEPARTMENT_BY_ROLE[key] || 'Unassigned';
  if (department === 'Trainee' && TRAINEE_DEPARTMENTS.has(user?.trainee_department)) return user.trainee_department;
  return department;
}

function text(value, max = 2000) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function ymd(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function num(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

// Compliance periods: the Evaluation's halves (YYYY-MM-H1 = 1st–15th, H2 =
// 16th–end) or a whole month (YYYY-MM). KPI is monthly only.
const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])(?:-H([12]))?$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentPeriod() {
  const today = manilaToday();
  return `${today.slice(0, 7)}-H${Number(today.slice(8, 10)) <= 15 ? 1 : 2}`;
}

function periodRange(period) {
  const match = PERIOD_PATTERN.exec(String(period || ''));
  if (!match) return null;
  const [, year, month, half] = match;
  const end = `${year}-${month}-${String(new Date(Number(year), Number(month), 0).getDate()).padStart(2, '0')}`;
  if (!half) return { from: `${year}-${month}-01`, to: end };
  return half === '1' ? { from: `${year}-${month}-01`, to: `${year}-${month}-15` } : { from: `${year}-${month}-16`, to: end };
}

function toMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function pct(credit, counted) {
  return counted ? Math.round((credit / counted) * 1000) / 10 : null;
}

// One KPI's score out of 100: reaching the target is 100, more is capped
// there. "lower" KPIs (e.g. RTS rate) score 100 at or under target.
function kpiScore(actual, target, direction) {
  if (actual === null || actual === undefined) return null;
  const a = Number(actual);
  const t = Number(target);
  if (!Number.isFinite(a) || !Number.isFinite(t)) return null;
  if (direction === 'lower') {
    if (a <= t) return 100;
    return a > 0 ? Math.round((t / a) * 1000) / 10 : 100;
  }
  if (t <= 0) return a > 0 ? 100 : 0;
  return Math.min(100, Math.round((a / t) * 1000) / 10);
}

module.exports = function performanceRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((error) => {
    console.error('[performance]', error);
    res.status(500).json({ error: error.message || 'Performance request failed' });
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

  // Everyone scored: active accounts except the super admin (as on the tracker).
  async function roster() {
    const users = await db.prepare(`
      SELECT id, full_name, username, role, trainee_department
      FROM users WHERE is_active = 1 AND COALESCE(is_super_admin, 0) = 0
      ORDER BY full_name
    `).all();
    return users.map((u) => ({
      id: Number(u.id),
      name: u.full_name || u.username || `User ${u.id}`,
      role: u.role || '',
      department: departmentOf(u),
    }));
  }

  // ─── Tracker marks ─────────────────────────────────────────
  router.get('/tracker', wrap(async (req, res) => {
    const from = ymd(req.query.from);
    const to = ymd(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    const rows = await db.prepare(`
      SELECT metric, user_id, work_date, state, note, link
      FROM employee_tracker_marks WHERE work_date BETWEEN ? AND ?
    `).all(from, to);
    res.json({ marks: rows.map((r) => ({ ...r, user_id: Number(r.user_id) })) });
  }));

  // Sets whichever of state / note / link the body carries; a row left with
  // none of the three is removed.
  router.put('/tracker', wrap(async (req, res) => {
    const body = req.body || {};
    const metric = String(body.metric || '');
    const userId = Number(body.user_id);
    const date = ymd(body.date);
    if (!TRACKER_METRICS.has(metric) || !userId || !date) return res.status(400).json({ error: 'metric, user_id and date are required' });
    if ('state' in body && body.state !== null && !TRACKER_STATES.has(body.state)) return res.status(400).json({ error: 'Unknown state' });

    const existing = await db.prepare('SELECT state, note, link FROM employee_tracker_marks WHERE metric = ? AND user_id = ? AND work_date = ?')
      .get(metric, userId, date);
    const next = {
      state: 'state' in body ? (body.state || null) : (existing?.state || null),
      note: 'note' in body ? text(body.note, 4000) : (existing?.note || null),
      link: 'link' in body ? text(body.link, 2000) : (existing?.link || null),
    };
    if (!next.state && !next.note && !next.link) {
      await db.prepare('DELETE FROM employee_tracker_marks WHERE metric = ? AND user_id = ? AND work_date = ?').run(metric, userId, date);
    } else if (existing) {
      await db.prepare(`
        UPDATE employee_tracker_marks SET state = ?, note = ?, link = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE metric = ? AND user_id = ? AND work_date = ?
      `).run(next.state, next.note, next.link, req.currentUser.id, metric, userId, date);
    } else {
      await db.prepare(`
        INSERT INTO employee_tracker_marks (metric, user_id, work_date, state, note, link, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(metric, userId, date, next.state, next.note, next.link, req.currentUser.id);
    }
    res.json({ ok: true, ...next });
  }));

  // One-time move of a browser's old localStorage marks. Only fills days the
  // server has nothing for, so it never overwrites what someone already saved.
  router.post('/tracker/import', wrap(async (req, res) => {
    const saved = req.body?.marks && typeof req.body.marks === 'object' ? req.body.marks : {};
    const entries = new Map();
    const entry = (metric, userId, date) => {
      const key = `${metric}|${userId}|${date}`;
      if (!entries.has(key)) entries.set(key, { metric, userId, date, state: null, note: null, link: null });
      return entries.get(key);
    };
    const valid = (metric, userId, date) => TRACKER_METRICS.has(metric) && Number(userId) > 0 && ymd(date);
    for (const [metric, byUser] of Object.entries(saved)) {
      if (metric.startsWith('_') || !byUser || typeof byUser !== 'object') continue;
      for (const [userId, days] of Object.entries(byUser)) {
        for (const [date, state] of Object.entries(days || {})) {
          if (valid(metric, userId, date) && TRACKER_STATES.has(state)) entry(metric, Number(userId), date).state = state;
        }
      }
    }
    for (const [metric, byUser] of Object.entries(saved._notes || {})) {
      for (const [userId, days] of Object.entries(byUser || {})) {
        for (const [date, note] of Object.entries(days || {})) {
          if (valid(metric, userId, date) && text(note)) entry(metric, Number(userId), date).note = text(note, 4000);
        }
      }
    }
    for (const [userId, days] of Object.entries(saved._links || {})) {
      for (const [date, link] of Object.entries(days || {})) {
        if (valid('eod', userId, date) && text(link)) entry('eod', Number(userId), date).link = text(link, 2000);
      }
    }
    let added = 0;
    for (const e of entries.values()) {
      const result = await db.prepare(`
        INSERT INTO employee_tracker_marks (metric, user_id, work_date, state, note, link, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (metric, user_id, work_date) DO NOTHING
      `).run(e.metric, e.userId, e.date, e.state, e.note, e.link, req.currentUser.id);
      added += Number(result?.changes || 0);
    }
    res.json({ received: entries.size, added });
  }));

  // ─── Category 2: Compliance ────────────────────────────────
  // Tracker metrics: yes = 1, late = ½, no = 0 over the days marked; rest days
  // and unmarked days don't count. Attendance: every scheduled day up to today
  // — on time = 1, late = ½, no time-in = 0; approved leave days don't count.
  router.get('/compliance', wrap(async (req, res) => {
    const period = PERIOD_PATTERN.test(String(req.query.period || '')) ? req.query.period : currentPeriod();
    const { from, to: periodEnd } = periodRange(period);
    const today = manilaToday();
    const to = periodEnd < today ? periodEnd : today;
    const people = await roster();
    const scores = new Map(people.map((p) => [p.id, Object.fromEntries(COMPLIANCE_METRICS.map((m) => [m, { credit: 0, counted: 0 }]))]));

    if (from <= to) {
      const marks = await db.prepare(`
        SELECT metric, user_id, state FROM employee_tracker_marks
        WHERE work_date BETWEEN ? AND ? AND state IS NOT NULL
      `).all(from, to);
      for (const mark of marks) {
        const bucket = scores.get(Number(mark.user_id))?.[mark.metric];
        if (!bucket || !(mark.state in STATE_CREDIT)) continue;
        bucket.counted += 1;
        bucket.credit += STATE_CREDIT[mark.state];
      }

      const schedules = await db.prepare(`
        SELECT user_id, schedule_date, shift_start FROM user_schedules
        WHERE schedule_date BETWEEN ? AND ? AND shift_start IS NOT NULL AND shift_start != ''
      `).all(from, to);
      const attendance = await db.prepare(`
        SELECT user_id, work_date, time_in FROM attendance_records WHERE work_date BETWEEN ? AND ?
      `).all(from, to);
      const leaves = await db.prepare(`
        SELECT user_id, leave_date_from, leave_date_to FROM leave_requests
        WHERE status = 'approved' AND leave_date_to >= ? AND leave_date_from <= ?
      `).all(from, to);
      const timeIn = new Map(attendance.filter((a) => a.time_in).map((a) => [`${a.user_id}|${a.work_date}`, a.time_in]));
      const onLeave = (userId, date) => leaves.some((l) => Number(l.user_id) === Number(userId) && l.leave_date_from <= date && l.leave_date_to >= date);
      for (const shift of schedules) {
        const bucket = scores.get(Number(shift.user_id))?.attendance;
        if (!bucket || onLeave(shift.user_id, shift.schedule_date)) continue;
        const inAt = timeIn.get(`${shift.user_id}|${shift.schedule_date}`);
        // Today only counts once they've timed in — the shift may not have started.
        if (!inAt && shift.schedule_date === today) continue;
        bucket.counted += 1;
        if (!inAt) continue;
        const start = toMinutes(shift.shift_start);
        const at = toMinutes(inAt);
        bucket.credit += start !== null && at !== null && at > start ? 0.5 : 1;
      }
    }

    const rows = people.map((person) => {
      const metrics = {};
      const values = [];
      for (const metric of COMPLIANCE_METRICS) {
        const { credit, counted } = scores.get(person.id)[metric];
        metrics[metric] = { score: pct(credit, counted), counted };
        if (counted) values.push(credit / counted);
      }
      const overall = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 10 : null;
      return { ...person, metrics, overall };
    });
    res.json({ period, from, to: periodEnd, metrics: COMPLIANCE_METRICS, rows });
  }));

  // ─── Category 3: KPI ───────────────────────────────────────
  async function activeItems() {
    const rows = await db.prepare('SELECT * FROM kpi_items WHERE is_active = 1 ORDER BY position, id').all();
    return rows.map((r) => ({
      id: Number(r.id),
      department: r.department || null,
      user_id: r.user_id == null ? null : Number(r.user_id),
      label: r.label,
      unit: r.unit || '',
      target: Number(r.target),
      direction: r.direction === 'lower' ? 'lower' : 'higher',
      weight: Number(r.weight) || 0,
      position: Number(r.position) || 0,
    }));
  }

  router.get('/kpi/setup', wrap(async (req, res) => {
    const overrides = await db.prepare('SELECT user_id, item_id, hidden, target FROM kpi_user_overrides').all();
    res.json({
      departments: DEPARTMENTS,
      people: await roster(),
      items: await activeItems(),
      overrides: overrides.map((o) => ({
        user_id: Number(o.user_id), item_id: Number(o.item_id), hidden: Number(o.hidden) === 1, target: o.target == null ? null : Number(o.target),
      })),
    });
  }));

  function cleanItem(body) {
    return {
      label: text(body.label, 200),
      unit: text(body.unit, 40),
      target: num(body.target) ?? 0,
      direction: body.direction === 'lower' ? 'lower' : 'higher',
      weight: Math.max(0, num(body.weight) ?? 1),
    };
  }

  // A department template KPI (department) or one person's own KPI (user_id).
  router.post('/kpi/items', wrap(async (req, res) => {
    const item = cleanItem(req.body || {});
    const department = text(req.body?.department, 80);
    const userId = Number(req.body?.user_id) || null;
    if (!item.label) return res.status(400).json({ error: 'KPI name is required' });
    if (!department === !userId) return res.status(400).json({ error: 'Pick a department or a person' });
    const max = await db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM kpi_items').get();
    const result = await db.prepare(`
      INSERT INTO kpi_items (department, user_id, label, unit, target, direction, weight, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId ? null : department, userId, item.label, item.unit, item.target, item.direction, item.weight, Number(max?.p || 0) + 1);
    res.status(201).json({ id: Number(result.lastInsertRowid) || null });
  }));

  router.put('/kpi/items/:id', wrap(async (req, res) => {
    const item = cleanItem(req.body || {});
    if (!item.label) return res.status(400).json({ error: 'KPI name is required' });
    const result = await db.prepare(`
      UPDATE kpi_items SET label = ?, unit = ?, target = ?, direction = ?, weight = ? WHERE id = ? AND is_active = 1
    `).run(item.label, item.unit, item.target, item.direction, item.weight, Number(req.params.id));
    if (!Number(result?.changes)) return res.status(404).json({ error: 'KPI not found' });
    res.json({ ok: true });
  }));

  // Removed KPIs are switched off, not deleted, so past periods keep their numbers.
  router.delete('/kpi/items/:id', wrap(async (req, res) => {
    await db.prepare('UPDATE kpi_items SET is_active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  }));

  // Per-person tweak of a department KPI: hide it or set their own target.
  router.put('/kpi/overrides', wrap(async (req, res) => {
    const userId = Number(req.body?.user_id);
    const itemId = Number(req.body?.item_id);
    if (!userId || !itemId) return res.status(400).json({ error: 'user_id and item_id are required' });
    const hidden = req.body?.hidden ? 1 : 0;
    const target = num(req.body?.target);
    if (!hidden && target === null) {
      await db.prepare('DELETE FROM kpi_user_overrides WHERE user_id = ? AND item_id = ?').run(userId, itemId);
    } else {
      await db.prepare(`
        INSERT INTO kpi_user_overrides (user_id, item_id, hidden, target) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, item_id) DO UPDATE SET hidden = excluded.hidden, target = excluded.target
      `).run(userId, itemId, hidden, target);
    }
    res.json({ ok: true });
  }));

  // Each person's KPI sheet for a month: their department's KPIs (minus
  // hidden ones, with their own target if set) plus their personal KPIs, the
  // actuals entered and a weighted score over the KPIs that have a number.
  router.get('/kpi/scores', wrap(async (req, res) => {
    const period = MONTH_PATTERN.test(String(req.query.period || '')) ? req.query.period : manilaToday().slice(0, 7);
    const [people, items, overrides, results] = await Promise.all([
      roster(),
      activeItems(),
      db.prepare('SELECT user_id, item_id, hidden, target FROM kpi_user_overrides').all(),
      db.prepare('SELECT user_id, item_id, actual, note FROM kpi_results WHERE period = ?').all(period),
    ]);
    const overrideBy = new Map(overrides.map((o) => [`${o.user_id}|${o.item_id}`, o]));
    const resultBy = new Map(results.map((r) => [`${r.user_id}|${r.item_id}`, r]));
    const rows = people.map((person) => {
      const mine = items.filter((item) => (item.user_id ? item.user_id === person.id : item.department === person.department));
      const kpis = [];
      for (const item of mine) {
        const override = overrideBy.get(`${person.id}|${item.id}`);
        if (override && Number(override.hidden) === 1) continue;
        const target = override?.target != null ? Number(override.target) : item.target;
        const result = resultBy.get(`${person.id}|${item.id}`);
        const actual = result?.actual == null ? null : Number(result.actual);
        kpis.push({
          item_id: item.id, label: item.label, unit: item.unit, direction: item.direction, weight: item.weight,
          personal: !!item.user_id, target, actual, note: result?.note || '', score: kpiScore(actual, target, item.direction),
        });
      }
      const scored = kpis.filter((k) => k.score !== null && k.weight > 0);
      const weightSum = scored.reduce((sum, k) => sum + k.weight, 0);
      const total = weightSum ? Math.round((scored.reduce((sum, k) => sum + k.score * k.weight, 0) / weightSum) * 10) / 10 : null;
      return { ...person, kpis, total };
    });
    res.json({ period, ...periodRange(period), rows });
  }));

  router.put('/kpi/results', wrap(async (req, res) => {
    const period = String(req.body?.period || '');
    const userId = Number(req.body?.user_id);
    const itemId = Number(req.body?.item_id);
    if (!MONTH_PATTERN.test(period) || !userId || !itemId) return res.status(400).json({ error: 'period (YYYY-MM), user_id and item_id are required' });
    const actual = num(req.body?.actual);
    const note = text(req.body?.note, 1000);
    if (actual === null && !note) {
      await db.prepare('DELETE FROM kpi_results WHERE period = ? AND user_id = ? AND item_id = ?').run(period, userId, itemId);
    } else {
      await db.prepare(`
        INSERT INTO kpi_results (period, user_id, item_id, actual, note, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (period, user_id, item_id) DO UPDATE SET actual = excluded.actual, note = excluded.note,
          updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
      `).run(period, userId, itemId, actual, note, req.currentUser.id);
    }
    res.json({ ok: true });
  }));

  return router;
};

module.exports.kpiScore = kpiScore;
module.exports.periodRange = periodRange;
