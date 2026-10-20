const express = require('express');
const pancakePosSync = require('../services/pancakePosSync');

// The Virtual Office: a 3D floor where each active account is a character that
// sits at its department's desks once timed in, walks to the break room while
// on lunch or the 15-minute break, and leaves when timed out. Everything is
// read from today's attendance_records — nobody clocks anything extra — plus
// the day's schedule (late / absent), rest days and approved leave, what each
// person got done (orders confirmed, RTS scans) and a few floor-wide numbers.
// HR and the super admin only; Operation clears the other HR gates but not
// this one.

const MANILA_TIMEZONE = 'Asia/Manila';
// How a character is drawn. Picked by HR per person; unset is a neutral look.
const VO_AVATARS = new Set(['male', 'female']);
// The order numbers scan a month of pos_orders, so they are shared and kept
// for a few minutes rather than recounted on every 30-second poll.
const KPI_TTL_MS = 5 * 60 * 1000;
const OUTPUT_TTL_MS = 60 * 1000;

function manilaNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`, weekday };
}

function toMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Where a person is right now, and since when (HH:MM, Manila). A break that
// is still open wins over being at the desk; a time out wins over everything.
function officeStatus(record) {
  if (!record || !record.time_in) return { status: 'not_in', since: null };
  if (record.time_out) return { status: 'left', since: record.time_out };
  if (record.break_out && !record.break_in) return { status: 'lunch', since: record.break_out };
  if (record.break2_out && !record.break2_in) return { status: 'break', since: record.break2_out };
  const back = [record.time_in, record.break_in, record.break2_in].filter(Boolean).sort();
  return { status: 'working', since: back[back.length - 1] };
}

// The day's standing against the schedule: rest day and leave first (nobody
// is expected), then late (timed in after the shift start — the Schedule
// page's rule) or absent (shift started, still not in).
function dayStanding({ record, shiftStart, restDay, leaveType, nowTime }) {
  if (leaveType) return { standing: 'on_leave', late_minutes: null };
  if (restDay && !record?.time_in) return { standing: 'rest_day', late_minutes: null };
  const shift = toMinutes(shiftStart);
  if (record?.time_in) {
    const clock = toMinutes(record.time_in);
    if (shift !== null && clock !== null && clock > shift) return { standing: 'late', late_minutes: clock - shift };
    return { standing: 'on_time', late_minutes: null };
  }
  if (shift !== null && toMinutes(nowTime) > shift) return { standing: 'absent', late_minutes: null };
  return { standing: shift !== null ? 'expected' : 'unscheduled', late_minutes: null };
}

module.exports = function virtualOfficeRoutes(db) {
  const router = express.Router();
  const cache = { kpis: null, kpisAt: 0, output: null, outputAt: 0, outputDate: '' };

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare(
        'SELECT id, role, is_super_admin FROM users WHERE id = ? AND is_active = 1'
      ).get(Number(req.user?.id) || 0);
      const role = String(user?.role || '').trim().toLowerCase();
      if (!user || (!['hr', 'administrator', 'admin'].includes(role) && Number(user.is_super_admin) !== 1)) {
        return res.status(403).json({ error: 'The Virtual Office is for HR and Administrators only.' });
      }
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Orders each linked confirmer confirmed today, and RTS parcels each
  // account scanned today, keyed by user id.
  async function dailyOutput(date) {
    if (cache.output && cache.outputDate === date && Date.now() - cache.outputAt < OUTPUT_TTL_MS) return cache.output;
    const confirmedDay = db.type === 'postgres'
      ? "to_char(confirmed_at::timestamp + interval '8 hours', 'YYYY-MM-DD')"
      : "date(confirmed_at, '+8 hours')";
    const confirmed = await db.prepare(`
      SELECT l.user_id, COUNT(*) AS n
      FROM pos_orders o
      JOIN user_pos_links l ON LOWER(TRIM(l.pos_name)) = LOWER(TRIM(o.confirmed_by_name))
      WHERE o.confirmed_at IS NOT NULL AND o.confirmed_at >= ? AND ${confirmedDay} = ?
      GROUP BY l.user_id
    `).all(`${prevDay(date)}T00:00:00`, date);
    const scans = await db.prepare(`
      SELECT scanned_by AS user_id, COUNT(*) AS n
      FROM scan_records WHERE scan_date = ? AND scan_type = 'RTS'
      GROUP BY scanned_by
    `).all(date);
    const out = new Map();
    const row = (id) => { if (!out.has(id)) out.set(id, { confirmed: 0, rts_scans: 0 }); return out.get(id); };
    confirmed.forEach((r) => { row(Number(r.user_id)).confirmed = Number(r.n || 0); });
    scans.forEach((r) => { row(Number(r.user_id)).rts_scans = Number(r.n || 0); });
    Object.assign(cache, { output: out, outputAt: Date.now(), outputDate: date });
    return out;
  }

  // Floor-wide numbers for the lounge TV: orders placed and confirmed today,
  // parcels picked up today, and this month's delivered count and RTS rate on
  // the effective status ((returning + returned) / settled, as the Data
  // Report counts it).
  async function floorKpis(date) {
    if (cache.kpis && cache.kpis.date === date && Date.now() - cache.kpisAt < KPI_TTL_MS) return cache.kpis;
    const day = pancakePosSync.posManilaDaySql(db.type);
    const eff = pancakePosSync.effectivePosStatusSql();
    const monthStart = `${date.slice(0, 7)}-01`;
    const confirmedDay = db.type === 'postgres'
      ? "to_char(confirmed_at::timestamp + interval '8 hours', 'YYYY-MM-DD')"
      : "date(confirmed_at, '+8 hours')";
    const month = await db.prepare(`
      SELECT
        SUM(CASE WHEN ${day} = ? THEN 1 ELSE 0 END) AS orders_today,
        SUM(CASE WHEN ${eff} = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN ${eff} = 'returning' THEN 1 ELSE 0 END) AS returning_count,
        SUM(CASE WHEN ${eff} = 'returned' THEN 1 ELSE 0 END) AS returned
      FROM pos_orders
      WHERE inserted_at_remote >= ? AND ${day} >= ?
    `).get(date, `${prevDay(monthStart)}T00:00:00`, monthStart);
    const confirmed = await db.prepare(`
      SELECT COUNT(*) AS n FROM pos_orders
      WHERE confirmed_at IS NOT NULL AND confirmed_at >= ? AND ${confirmedDay} = ?
    `).get(`${prevDay(date)}T00:00:00`, date);
    const pickups = await db.prepare('SELECT COUNT(*) AS n FROM pickup_log WHERE pickup_date = ?').get(date);
    const delivered = Number(month?.delivered || 0);
    const rts = Number(month?.returning_count || 0) + Number(month?.returned || 0);
    const kpis = {
      date,
      orders_today: Number(month?.orders_today || 0),
      confirmed_today: Number(confirmed?.n || 0),
      pickups_today: Number(pickups?.n || 0),
      delivered_month: delivered,
      rts_rate_month: delivered + rts ? (rts / (delivered + rts)) * 100 : 0,
    };
    Object.assign(cache, { kpis, kpisAt: Date.now() });
    return kpis;
  }

  router.get('/', async (req, res) => {
    try {
      const now = manilaNow();
      // The super admin is the one watching, not a seat on the floor — the
      // Employee Tracker leaves them off its roster the same way.
      const people = await db.prepare(`
        SELECT u.id, u.full_name, u.username, u.role, u.trainee_department, u.avatar_gender, u.desk_order, u.day_off,
               a.time_in, a.break_out, a.break_in, a.break2_out, a.break2_in, a.time_out,
               s.shift_start, s.shift_end
        FROM users u
        LEFT JOIN attendance_records a ON a.user_id = u.id AND a.work_date = ?
        LEFT JOIN user_schedules s ON s.user_id = u.id AND s.schedule_date = ?
        WHERE u.is_active = 1 AND COALESCE(u.is_super_admin, 0) <> 1
        ORDER BY u.full_name COLLATE NOCASE ASC
      `).all(now.date, now.date);
      const leaves = await db.prepare(`
        SELECT user_id, leave_type FROM leave_requests
        WHERE status = 'approved' AND leave_date_from <= ? AND leave_date_to >= ?
      `).all(now.date, now.date);
      const leaveOf = new Map(leaves.map((l) => [Number(l.user_id), l.leave_type || 'Leave']));
      // Lates so far this month, by the same rule, for the person card.
      const monthLates = await db.prepare(`
        SELECT a.user_id, COUNT(*) AS n
        FROM attendance_records a
        JOIN user_schedules s ON s.user_id = a.user_id AND s.schedule_date = a.work_date
        WHERE a.work_date >= ? AND a.work_date <= ? AND a.time_in IS NOT NULL
          AND s.shift_start IS NOT NULL AND a.time_in > s.shift_start
        GROUP BY a.user_id
      `).all(`${now.date.slice(0, 7)}-01`, now.date);
      const latesOf = new Map(monthLates.map((r) => [Number(r.user_id), Number(r.n || 0)]));
      const output = await dailyOutput(now.date);
      const kpis = await floorKpis(now.date).catch(() => null);

      res.json({
        date: now.date,
        time: now.time,
        kpis,
        people: people.map((row) => {
          const id = Number(row.id);
          const restDay = Number(row.day_off) === now.weekday;
          return {
            id,
            name: row.full_name || row.username,
            role: row.role || null,
            trainee_department: row.trainee_department || null,
            avatar_gender: VO_AVATARS.has(row.avatar_gender) ? row.avatar_gender : null,
            desk_order: row.desk_order === null || row.desk_order === undefined ? null : Number(row.desk_order),
            ...officeStatus(row),
            ...dayStanding({ record: row, shiftStart: row.shift_start, restDay, leaveType: leaveOf.get(id), nowTime: now.time }),
            leave_type: leaveOf.get(id) || null,
            shift: row.shift_start ? { start: row.shift_start, end: row.shift_end || null } : null,
            punches: {
              time_in: row.time_in || null,
              break_out: row.break_out || null,
              break_in: row.break_in || null,
              break2_out: row.break2_out || null,
              break2_in: row.break2_in || null,
              time_out: row.time_out || null,
            },
            output: output.get(id) || { confirmed: 0, rts_scans: 0 },
            lates_this_month: latesOf.get(id) || 0,
          };
        }),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // HR (or the super admin) picks how someone's character looks.
  router.put('/avatar/:userId', async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user.' });
      const raw = req.body?.gender;
      const gender = raw === null || raw === '' ? null : String(raw).trim().toLowerCase();
      if (gender !== null && !VO_AVATARS.has(gender)) {
        return res.status(400).json({ error: 'Avatar must be male, female or empty.' });
      }
      const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      await db.prepare('UPDATE users SET avatar_gender = ? WHERE id = ?').run(gender, userId);
      res.json({ id: userId, avatar_gender: gender });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // HR fixes the seating of a team: the ids in the order their seats run,
  // starting next to the team wall. Saved as each account's desk_order.
  router.put('/seats', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
      if (!ids || !ids.length || ids.length > 200 || ids.some((id) => !Number.isInteger(id) || id <= 0)
        || new Set(ids).size !== ids.length) {
        return res.status(400).json({ error: 'Send the team\'s user ids in seat order.' });
      }
      const found = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids);
      if (Number(found?.n || 0) !== ids.length) return res.status(404).json({ error: 'Some of those users do not exist.' });
      for (let i = 0; i < ids.length; i += 1) {
        await db.prepare('UPDATE users SET desk_order = ? WHERE id = ?').run(i, ids[i]);
      }
      res.json({ ids });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

function prevDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports.officeStatus = officeStatus;
module.exports.dayStanding = dayStanding;
