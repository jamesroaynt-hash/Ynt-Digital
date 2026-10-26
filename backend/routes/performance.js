const express = require('express');

// Performance: Employee Tracker marks, and the two scoring categories that sit
// beside the peer Evaluation without touching it —
//   Compliance (Category 2): worked out from the tracker marks (Standup, EOD,
//     Self-Care, WAM) and Time & Attendance, per 15-day period.
//   KPI (Category 3): department KPI templates with per-person tweaks; HR
//     enters each person's actual number per month (ad budget and ROAS run
//     monthly). A ratio such as ROAS is just a KPI with its target, e.g. 3.
//     A department KPI can be the whole team's target (split): e.g. CSR's
//     monthly orders target is shared out over the CSRs. A "daily" KPI (CSR
//     total orders) is typed in by HR every day — on Daily Entry, or for an
//     "orders" KPI on the Employee Tracker's Confirmed Orders tab (both screens
//     edit the same number); its month actual is the sum,
//     and the person's monthly share ÷ their scheduled days is their daily
//     target.
// HR's, Operation's and the super admin's alone — the same gate as the rest of
// HR (routes/hr.js, routes/hrRecords.js).
const HR_MANAGER_ROLES = new Set(['hr', 'operation', 'operations']);

function isHrManager(user) {
  if (Number(user?.is_super_admin) === 1) return true;
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

const TRACKER_METRICS = new Set(['standup', 'eod', 'selfcare', 'wam', 'discordlive', 'orders']);
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

// No Schedule row that day = the standard 8:00 AM – 5:00 PM shift (8 hours
// plus the 1-hour lunch): timing in at 8:01 or later is late.
const DEFAULT_SHIFT_START = '08:00';

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function pct(credit, counted) {
  return counted ? Math.round((credit / counted) * 1000) / 10 : null;
}

// Pace for a daily KPI: the month so far against what the daily target says
// should be done by now. Not capped, so ahead of pace reads above 100.
function paceScore(actual, expected, direction) {
  if (!(expected > 0)) return null;
  const a = Number(actual) || 0;
  if (direction === 'lower') return a > 0 ? Math.round((expected / a) * 1000) / 10 : 100;
  return Math.round((a / expected) * 1000) / 10;
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

  // Each person's day from Schedule + Time & Attendance: on time (yes), late,
  // no time-in (no), approved leave, or today's shift not timed in yet
  // (pending). The person's weekly day off (users.day_off, as in payroll) is
  // dayoff — even if a shift row lands on it — and a punch on it comes back as
  // rest (worked a rest day). A punch on a day with no Schedule row is judged
  // against the standard 8:00 AM start (DEFAULT_SHIFT_START). Compliance
  // scores these and the Employee Tracker's Attendance tab shows them, so the
  // two always agree; dayoff and rest are never scored.
  async function attendanceDays(from, to) {
    const today = manilaToday();
    const [schedules, attendance, leaves, dayOffs] = await Promise.all([
      db.prepare(`
        SELECT user_id, schedule_date, shift_start FROM user_schedules
        WHERE schedule_date BETWEEN ? AND ? AND shift_start IS NOT NULL AND shift_start != ''
      `).all(from, to),
      db.prepare(`
        SELECT user_id, work_date, time_in, time_out FROM attendance_records WHERE work_date BETWEEN ? AND ?
      `).all(from, to),
      db.prepare(`
        SELECT user_id, leave_date_from, leave_date_to FROM leave_requests
        WHERE status = 'approved' AND leave_date_to >= ? AND leave_date_from <= ?
      `).all(from, to),
      db.prepare('SELECT id, day_off FROM users WHERE is_active = 1 AND day_off BETWEEN 0 AND 6').all(),
    ]);
    const dayOffOf = new Map(dayOffs.map((u) => [Number(u.id), Number(u.day_off)]));
    const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
    const isDayOff = (userId, date) => dayOffOf.get(Number(userId)) === weekday(date);
    const punches = new Map(attendance.filter((a) => a.time_in).map((a) => [`${a.user_id}|${a.work_date}`, a]));
    const onLeave = (userId, date) => leaves.some((l) => Number(l.user_id) === Number(userId) && l.leave_date_from <= date && l.leave_date_to >= date);
    const days = [];
    const scheduled = new Set();
    for (const shift of schedules) {
      const key = `${shift.user_id}|${shift.schedule_date}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      const punch = punches.get(key);
      let status;
      if (isDayOff(shift.user_id, shift.schedule_date)) status = punch ? 'rest' : 'dayoff';
      else if (onLeave(shift.user_id, shift.schedule_date)) status = 'leave';
      else if (!punch) status = shift.schedule_date === today ? 'pending' : (shift.schedule_date > today ? 'upcoming' : 'no');
      else {
        const start = toMinutes(shift.shift_start);
        const at = toMinutes(punch.time_in);
        status = start !== null && at !== null && at > start ? 'late' : 'yes';
      }
      days.push({
        user_id: Number(shift.user_id),
        work_date: shift.schedule_date,
        status,
        shift_start: shift.shift_start,
        time_in: punch?.time_in || null,
        time_out: punch?.time_out || null,
      });
    }
    for (const [key, punch] of punches) {
      if (scheduled.has(key)) continue;
      const restDay = isDayOff(punch.user_id, punch.work_date);
      const at = toMinutes(punch.time_in);
      const status = restDay ? 'rest' : (at !== null && at > toMinutes(DEFAULT_SHIFT_START) ? 'late' : 'yes');
      days.push({
        user_id: Number(punch.user_id),
        work_date: punch.work_date,
        status,
        shift_start: restDay ? null : DEFAULT_SHIFT_START,
        time_in: punch.time_in,
        time_out: punch.time_out || null,
      });
      scheduled.add(key);
    }
    // Day off with no shift row and no punch: still worth showing.
    for (const [userId] of dayOffOf) {
      for (let date = from; date <= to; date = nextDay(date)) {
        const key = `${userId}|${date}`;
        if (scheduled.has(key) || !isDayOff(userId, date)) continue;
        days.push({ user_id: userId, work_date: date, status: 'dayoff', shift_start: null, time_in: null, time_out: null });
      }
    }
    return days;
  }

  router.get('/tracker/attendance', wrap(async (req, res) => {
    const from = ymd(req.query.from);
    const to = ymd(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 92) return res.status(400).json({ error: 'Pick a range of up to 92 days' });
    res.json({ days: await attendanceDays(from, to) });
  }));

  // ─── Tracker marks ─────────────────────────────────────────
  async function writeTrackerEntry(metric, userId, date, body, by) {
    const existing = await db.prepare('SELECT state, note, link, value FROM employee_tracker_marks WHERE metric = ? AND user_id = ? AND work_date = ?')
      .get(metric, userId, date);
    const next = {
      state: 'state' in body ? (body.state || null) : (existing?.state || null),
      note: 'note' in body ? text(body.note, 4000) : (existing?.note || null),
      link: 'link' in body ? text(body.link, 2000) : (existing?.link || null),
      value: 'value' in body ? num(body.value) : (existing?.value == null ? null : Number(existing.value)),
    };
    if (!next.state && !next.note && !next.link && next.value === null) {
      await db.prepare('DELETE FROM employee_tracker_marks WHERE metric = ? AND user_id = ? AND work_date = ?').run(metric, userId, date);
    } else if (existing) {
      await db.prepare(`
        UPDATE employee_tracker_marks SET state = ?, note = ?, link = ?, value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE metric = ? AND user_id = ? AND work_date = ?
      `).run(next.state, next.note, next.link, next.value, by, metric, userId, date);
    } else {
      await db.prepare(`
        INSERT INTO employee_tracker_marks (metric, user_id, work_date, state, note, link, value, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(metric, userId, date, next.state, next.note, next.link, next.value, by);
    }
    return next;
  }

  router.get('/tracker', wrap(async (req, res) => {
    const from = ymd(req.query.from);
    const to = ymd(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    const rows = await db.prepare(`
      SELECT metric, user_id, work_date, state, note, link, value
      FROM employee_tracker_marks WHERE work_date BETWEEN ? AND ?
    `).all(from, to);
    res.json({ marks: rows.map((r) => ({ ...r, user_id: Number(r.user_id), value: r.value == null ? null : Number(r.value) })) });
  }));

  // Sets whichever of state / note / link / value the body carries; a row left
  // with none of them is removed.
  router.put('/tracker', wrap(async (req, res) => {
    const body = req.body || {};
    const metric = String(body.metric || '');
    const userId = Number(body.user_id);
    const date = ymd(body.date);
    if (!TRACKER_METRICS.has(metric) || !userId || !date) return res.status(400).json({ error: 'metric, user_id and date are required' });
    if ('state' in body && body.state !== null && !TRACKER_STATES.has(body.state)) return res.status(400).json({ error: 'Unknown state' });

    if ('value' in body && body.value !== null && num(body.value) === null) return res.status(400).json({ error: 'Value must be a number' });
    res.json({ ok: true, ...(await writeTrackerEntry(metric, userId, date, body, req.currentUser.id)) });
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

      // Leave, rest-day punches and today's not-yet-timed-in shift don't count.
      for (const day of await attendanceDays(from, to)) {
        const bucket = scores.get(day.user_id)?.attendance;
        if (!bucket || !(day.status in STATE_CREDIT)) continue;
        bucket.counted += 1;
        bucket.credit += STATE_CREDIT[day.status];
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
      // 'orders' is a daily KPI whose numbers come from the tracker's
      // Confirmed Orders tab; everything else reads it as daily.
      entry: r.entry === 'daily' || r.entry === 'orders' ? 'daily' : 'monthly',
      source: r.entry === 'orders' ? 'orders' : 'manual',
      split: Number(r.split) === 1 && !r.user_id,
    }));
  }

  // Every person's KPIs with the target that applies to them: their
  // department's (minus hidden, their own target if set) plus their personal
  // ones. A split (whole-department) target is shared out: what's left after
  // the people with their own target, divided evenly over everyone else.
  function resolveKpis(people, items, overrideBy) {
    const byPerson = new Map(people.map((p) => [p.id, []]));
    for (const item of items) {
      const members = people.filter((p) => {
        if (item.user_id ? item.user_id !== p.id : item.department !== p.department) return false;
        return Number(overrideBy.get(`${p.id}|${item.id}`)?.hidden) !== 1;
      });
      const own = (p) => overrideBy.get(`${p.id}|${item.id}`)?.target;
      let share = item.target;
      if (item.split) {
        const fixed = members.filter((p) => own(p) != null);
        const rest = members.length - fixed.length;
        const left = Math.max(0, item.target - fixed.reduce((sum, p) => sum + Number(own(p)), 0));
        share = rest ? Math.round((left / rest) * 100) / 100 : 0;
      }
      for (const p of members) {
        byPerson.get(p.id).push({ ...item, team_target: item.split ? item.target : null, target: own(p) != null ? Number(own(p)) : share });
      }
    }
    return byPerson;
  }

  // Team lines for split KPIs: the department's target against everyone's sum.
  // expectedOf (optional) gives a member's expected-so-far for a daily KPI,
  // so the team gets a pace too.
  function teamTotals(items, byPerson, actualOf, expectedOf) {
    return items.filter((item) => item.split).map((item) => {
      let total = 0;
      let expected = 0;
      let members = 0;
      for (const [personId, kpis] of byPerson) {
        const mine = kpis.find((k) => k.id === item.id);
        if (!mine) continue;
        members += 1;
        total += Number(actualOf(personId, item) || 0);
        if (expectedOf) expected += Number(expectedOf(personId, mine) || 0);
      }
      return {
        department: item.department, item_id: item.id, label: item.label, unit: item.unit, direction: item.direction,
        target: item.target, total: Math.round(total * 100) / 100, members, score: kpiScore(total, item.target, item.direction),
        pace: item.entry === 'daily' && expectedOf ? paceScore(total, expected, item.direction) : null,
      };
    }).filter((team) => team.members);
  }

  // The KPIs with this month's target where one was set for the month.
  async function itemsForMonth(month) {
    const [items, targets] = await Promise.all([
      activeItems(),
      db.prepare('SELECT item_id, target FROM kpi_period_targets WHERE period = ?').all(month),
    ]);
    const byItem = new Map(targets.map((t) => [Number(t.item_id), Number(t.target)]));
    return items.map((item) => (byItem.has(item.id) ? { ...item, target: byItem.get(item.id), month_target: true } : item));
  }

  // The team's daily target: the sum of its members' daily targets.
  function byPersonDailyTarget(byPerson, itemId, daysFor) {
    let total = 0;
    for (const [personId, kpis] of byPerson) {
      const mine = kpis.find((k) => k.id === itemId);
      if (mine) total += mine.target / daysFor(personId).days;
    }
    return total;
  }

  async function overrideMap() {
    const overrides = await db.prepare('SELECT user_id, item_id, hidden, target FROM kpi_user_overrides').all();
    return new Map(overrides.map((o) => [`${o.user_id}|${o.item_id}`, o]));
  }

  // Working days per person in a month = days on their Schedule; with no
  // schedule yet, every day of the month. `elapsed` is how many of those fall
  // on or before today (all of them for a past month) — what pace counts.
  async function workDays(month) {
    const { from, to } = periodRange(month);
    const today = manilaToday();
    const upTo = today < to ? today : to;
    const rows = await db.prepare(`
      SELECT user_id, COUNT(DISTINCT schedule_date) AS n,
        COUNT(DISTINCT CASE WHEN schedule_date <= ? THEN schedule_date END) AS done
      FROM user_schedules
      WHERE schedule_date BETWEEN ? AND ? AND shift_start IS NOT NULL AND shift_start != ''
      GROUP BY user_id
    `).all(upTo, from, to);
    const byUser = new Map(rows.map((r) => [Number(r.user_id), { days: Number(r.n), elapsed: Number(r.done) }]));
    const calendarDays = Number(to.slice(8, 10));
    const calendarElapsed = upTo < from ? 0 : Number(upTo.slice(8, 10));
    return (userId) => {
      const scheduled = byUser.get(userId);
      return scheduled && scheduled.days
        ? { ...scheduled, fromSchedule: true }
        : { days: calendarDays, elapsed: calendarElapsed, fromSchedule: false };
    };
  }

  // Month totals of daily KPIs: user|item → sum and days entered. KPIs fed by
  // the tracker's Confirmed Orders all read the same per-person numbers.
  async function dailySums(month, items) {
    const { from, to } = periodRange(month);
    const rows = await db.prepare(`
      SELECT user_id, item_id, SUM(value) AS total, COUNT(value) AS days FROM kpi_daily
      WHERE work_date BETWEEN ? AND ? AND value IS NOT NULL GROUP BY user_id, item_id
    `).all(from, to);
    const sums = new Map(rows.map((r) => [`${r.user_id}|${r.item_id}`, { total: Number(r.total), days: Number(r.days) }]));
    const ordersItems = items.filter((item) => item.source === 'orders');
    if (ordersItems.length) {
      const orders = await db.prepare(`
        SELECT user_id, SUM(value) AS total, COUNT(value) AS days FROM employee_tracker_marks
        WHERE metric = 'orders' AND work_date BETWEEN ? AND ? AND value IS NOT NULL GROUP BY user_id
      `).all(from, to);
      for (const r of orders) {
        for (const item of ordersItems) sums.set(`${r.user_id}|${item.id}`, { total: Number(r.total), days: Number(r.days) });
      }
    }
    return sums;
  }

  async function ordersOn(date) {
    const rows = await db.prepare(`
      SELECT user_id, value FROM employee_tracker_marks WHERE metric = 'orders' AND work_date = ? AND value IS NOT NULL
    `).all(date);
    return new Map(rows.map((r) => [Number(r.user_id), Number(r.value)]));
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
      entry: ['daily', 'orders'].includes(body.entry) ? body.entry : 'monthly',
      split: body.split === true || body.split === 1 || body.split === '1' || body.split === 'team' ? 1 : 0,
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
      INSERT INTO kpi_items (department, user_id, label, unit, target, direction, weight, entry, split, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId ? null : department, userId, item.label, item.unit, item.target, item.direction, item.weight, item.entry,
      userId ? 0 : item.split, Number(max?.p || 0) + 1);
    res.status(201).json({ id: Number(result.lastInsertRowid) || null });
  }));

  router.put('/kpi/items/:id', wrap(async (req, res) => {
    const item = cleanItem(req.body || {});
    if (!item.label) return res.status(400).json({ error: 'KPI name is required' });
    const result = await db.prepare(`
      UPDATE kpi_items SET label = ?, unit = ?, target = ?, direction = ?, weight = ?, entry = ?,
        split = CASE WHEN user_id IS NULL THEN ? ELSE 0 END
      WHERE id = ? AND is_active = 1
    `).run(item.label, item.unit, item.target, item.direction, item.weight, item.entry, item.split, Number(req.params.id));
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

  // Each person's KPI sheet for a month: their KPIs, the actuals (typed in, or
  // summed from the daily entries for a daily KPI) and a weighted score over
  // the KPIs that have a number.
  router.get('/kpi/scores', wrap(async (req, res) => {
    const period = MONTH_PATTERN.test(String(req.query.period || '')) ? req.query.period : manilaToday().slice(0, 7);
    const [people, items, overrideBy, results, daysFor] = await Promise.all([
      roster(),
      itemsForMonth(period),
      overrideMap(),
      db.prepare('SELECT user_id, item_id, actual, note FROM kpi_results WHERE period = ?').all(period),
      workDays(period),
    ]);
    const sums = await dailySums(period, items);
    const resultBy = new Map(results.map((r) => [`${r.user_id}|${r.item_id}`, r]));
    const byPerson = resolveKpis(people, items, overrideBy);
    const actualOf = (personId, item) => (item.entry === 'daily'
      ? sums.get(`${personId}|${item.id}`)?.total ?? null
      : (resultBy.get(`${personId}|${item.id}`)?.actual == null ? null : Number(resultBy.get(`${personId}|${item.id}`).actual)));
    const rows = people.map((person) => {
      const kpis = byPerson.get(person.id).map((item) => {
        const result = resultBy.get(`${person.id}|${item.id}`);
        const daily = item.entry === 'daily' ? sums.get(`${person.id}|${item.id}`) : null;
        const actual = item.entry === 'daily' ? (daily ? daily.total : null) : (result?.actual == null ? null : Number(result.actual));
        const work = daysFor(person.id);
        return {
          item_id: item.id, label: item.label, unit: item.unit, direction: item.direction, weight: item.weight, entry: item.entry,
          personal: !!item.user_id, target: item.target, team_target: item.team_target, actual, note: result?.note || '',
          score: kpiScore(actual, item.target, item.direction),
          ...(item.entry === 'daily' ? {
            daily_target: Math.round((item.target / work.days) * 100) / 100,
            work_days: work.days,
            days_elapsed: work.elapsed,
            days_entered: daily?.days || 0,
            expected: Math.round(((item.target / work.days) * work.elapsed) * 100) / 100,
            pace: paceScore(actual, (item.target / work.days) * work.elapsed, item.direction),
          } : {}),
        };
      });
      const weighted = (valueOf) => {
        const scored = kpis.map((k) => [k, valueOf(k)]).filter(([k, v]) => v !== null && v !== undefined && k.weight > 0);
        const weightSum = scored.reduce((sum, [k]) => sum + k.weight, 0);
        return weightSum ? Math.round((scored.reduce((sum, [k, v]) => sum + v * k.weight, 0) / weightSum) * 10) / 10 : null;
      };
      // Pace total: daily KPIs by their pace, the rest by their score.
      return { ...person, kpis, total: weighted((k) => k.score), pace: weighted((k) => (k.entry === 'daily' ? k.pace : k.score)) };
    });
    const expectedOf = (personId, item) => {
      const work = daysFor(personId);
      return (item.target / work.days) * work.elapsed;
    };
    res.json({ period, ...periodRange(period), rows, teams: teamTotals(items, byPerson, actualOf, expectedOf) });
  }));

  // HR's daily screen: everyone with a daily KPI, that day's number, their
  // daily target and how the month stands so far.
  router.get('/kpi/daily', wrap(async (req, res) => {
    const date = ymd(req.query.date) || manilaToday();
    const month = date.slice(0, 7);
    const [people, items, overrideBy, daysFor, entries, orders] = await Promise.all([
      roster(),
      itemsForMonth(month),
      overrideMap(),
      workDays(month),
      db.prepare('SELECT user_id, item_id, value FROM kpi_daily WHERE work_date = ?').all(date),
      ordersOn(date),
    ]);
    const sums = await dailySums(month, items);
    const valueBy = new Map(entries.map((e) => [`${e.user_id}|${e.item_id}`, e.value == null ? null : Number(e.value)]));
    const dailyItems = items.filter((item) => item.entry === 'daily');
    for (const item of dailyItems.filter((i) => i.source === 'orders')) {
      for (const [userId, value] of orders) valueBy.set(`${userId}|${item.id}`, value);
    }
    const byPerson = resolveKpis(people, dailyItems, overrideBy);
    const rows = people.map((person) => {
      const work = daysFor(person.id);
      const kpis = byPerson.get(person.id).map((item) => {
        const sum = sums.get(`${person.id}|${item.id}`);
        const dailyTarget = item.target / work.days;
        const value = valueBy.has(`${person.id}|${item.id}`) ? valueBy.get(`${person.id}|${item.id}`) : null;
        const monthTotal = sum ? sum.total : 0;
        return {
          item_id: item.id, label: item.label, unit: item.unit, direction: item.direction, source: item.source,
          target: item.target,
          team_target: item.team_target,
          daily_target: Math.round(dailyTarget * 100) / 100,
          work_days: work.days,
          value,
          // Uncapped: over 100% means they beat the day's / month's target.
          daily_pct: value === null ? null : paceScore(value, dailyTarget, item.direction),
          month_total: monthTotal,
          monthly_pct: paceScore(monthTotal, item.target, item.direction),
          days_entered: sum ? sum.days : 0,
        };
      });
      return { ...person, kpis };
    }).filter((person) => person.kpis.length);
    const teams = teamTotals(dailyItems, byPerson, (personId, item) => sums.get(`${personId}|${item.id}`)?.total ?? 0)
      .map((team) => {
        let day = 0;
        for (const [personId, kpis] of byPerson) {
          if (kpis.some((k) => k.id === team.item_id)) day += Number(valueBy.get(`${personId}|${team.item_id}`) || 0);
        }
        const dailyTarget = byPersonDailyTarget(byPerson, team.item_id, daysFor);
        return {
          ...team,
          day: Math.round(day * 100) / 100,
          daily_target: Math.round(dailyTarget * 100) / 100,
          daily_pct: paceScore(day, dailyTarget, team.direction),
          monthly_pct: paceScore(team.total, team.target, team.direction),
        };
      });
    // Every daily KPI with its month target, so the KPI tab can set it even
    // before anyone is in the department.
    const targets = dailyItems.filter((item) => !item.user_id).map((item) => ({
      item_id: item.id, department: item.department, label: item.label, unit: item.unit,
      target: item.target, split: item.split, month_target: !!item.month_target,
      members: [...byPerson.values()].filter((kpis) => kpis.some((k) => k.id === item.id)).length,
    }));
    res.json({ date, month, rows, teams, targets });
  }));

  // Sets (or with a blank target clears) a KPI's target for one month.
  router.put('/kpi/period-target', wrap(async (req, res) => {
    const itemId = Number(req.body?.item_id);
    const period = String(req.body?.period || '');
    if (!itemId || !MONTH_PATTERN.test(period)) return res.status(400).json({ error: 'item_id and period (YYYY-MM) are required' });
    const target = num(req.body?.target);
    if (target === null) {
      await db.prepare('DELETE FROM kpi_period_targets WHERE item_id = ? AND period = ?').run(itemId, period);
    } else {
      await db.prepare(`
        INSERT INTO kpi_period_targets (item_id, period, target, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (item_id, period) DO UPDATE SET target = excluded.target, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
      `).run(itemId, period, target, req.currentUser.id);
    }
    res.json({ ok: true });
  }));

  router.put('/kpi/daily', wrap(async (req, res) => {
    const date = ymd(req.body?.date);
    const userId = Number(req.body?.user_id);
    const itemId = Number(req.body?.item_id);
    if (!date || !userId || !itemId) return res.status(400).json({ error: 'date, user_id and item_id are required' });
    const value = num(req.body?.value);
    // An "orders" KPI's number is the tracker's Confirmed Orders entry.
    const item = await db.prepare('SELECT entry FROM kpi_items WHERE id = ?').get(itemId);
    if (item?.entry === 'orders') {
      await writeTrackerEntry('orders', userId, date, { value }, req.currentUser.id);
    } else if (value === null) {
      await db.prepare('DELETE FROM kpi_daily WHERE work_date = ? AND user_id = ? AND item_id = ?').run(date, userId, itemId);
    } else {
      await db.prepare(`
        INSERT INTO kpi_daily (work_date, user_id, item_id, value, updated_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (work_date, user_id, item_id) DO UPDATE SET value = excluded.value,
          updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
      `).run(date, userId, itemId, value, req.currentUser.id);
    }
    res.json({ ok: true });
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
