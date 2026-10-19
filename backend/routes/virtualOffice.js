const express = require('express');

// The Virtual Office: a 3D floor where each active account is a character that
// sits at its department's desks once timed in, walks to the break room while
// on lunch or the 15-minute break, and leaves when timed out. Everything is
// read from today's attendance_records — nobody clocks anything extra.
// HR and the super admin only; Operation clears the other HR gates but not
// this one.

const MANILA_TIMEZONE = 'Asia/Manila';

function manilaNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
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

module.exports = function virtualOfficeRoutes(db) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare(
        'SELECT id, role, is_super_admin FROM users WHERE id = ? AND is_active = 1'
      ).get(Number(req.user?.id) || 0);
      const role = String(user?.role || '').trim().toLowerCase();
      if (!user || (role !== 'hr' && Number(user.is_super_admin) !== 1)) {
        return res.status(403).json({ error: 'The Virtual Office is for HR and the super admin only.' });
      }
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const now = manilaNow();
      // The super admin is the one watching, not a seat on the floor — the
      // Employee Tracker leaves them off its roster the same way.
      const people = await db.prepare(`
        SELECT u.id, u.full_name, u.username, u.role,
               a.time_in, a.break_out, a.break_in, a.break2_out, a.break2_in, a.time_out
        FROM users u
        LEFT JOIN attendance_records a ON a.user_id = u.id AND a.work_date = ?
        WHERE u.is_active = 1 AND COALESCE(u.is_super_admin, 0) <> 1
        ORDER BY u.full_name COLLATE NOCASE ASC
      `).all(now.date);
      res.json({
        date: now.date,
        time: now.time,
        people: people.map((row) => ({
          id: row.id,
          name: row.full_name || row.username,
          role: row.role || null,
          ...officeStatus(row),
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports.officeStatus = officeStatus;
