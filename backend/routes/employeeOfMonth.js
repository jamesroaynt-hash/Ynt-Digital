const express = require('express');
const { isHrManager } = require('./performance');

// Employee of the Month: everybody votes once a month for one colleague, in
// the last five days of the month (Manila time) — the same five-day stretch
// the second-half Evaluation is filled in. A ballot can be changed until
// voting closes. The tally and the written answers are read by HR, Operation
// and the super admin only (isHrManager); the voters' names by the super
// admin only, like the evaluator names on the peer Evaluation. Schema in
// db/employeeOfMonthSchema.js.

const MANILA_TIMEZONE = 'Asia/Manila';
const VOTE_DAYS = 5;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ANSWER_FIELDS = ['why_chosen', 'qualities', 'achievement', 'why_deserving'];
const MAX_ANSWER = 2000;

function manilaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function monthLabel(month) {
  const [year, mm] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mm - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// The month being voted on and whether voting is open today.
function voteWindow(today = manilaDate()) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const opensDay = lastDay - (VOTE_DAYS - 1);
  const key = today.slice(0, 7);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    month: key,
    label: monthLabel(key),
    today,
    opens_on: `${key}-${pad(opensDay)}`,
    closes_on: `${key}-${pad(lastDay)}`,
    open: day >= opensDay,
    days_until_open: Math.max(0, opensDay - day),
  };
}

function personName(row) {
  return row?.full_name || row?.username || `User ${row?.id}`;
}

module.exports = function employeeOfMonthRoutes(db) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare('SELECT id, role, is_super_admin FROM users WHERE id = ? AND is_active = 1').get(req.user?.id);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.currentUser = user;
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  // Everyone who can be voted for: active accounts other than the super admin.
  async function roster() {
    const users = await db.prepare(`
      SELECT id, full_name, username, role
      FROM users WHERE is_active = 1 AND COALESCE(is_super_admin, 0) = 0
      ORDER BY full_name
    `).all();
    return users.map((u) => ({ id: Number(u.id), name: personName(u), role: u.role || '' }));
  }

  function serializeBallot(row) {
    if (!row) return null;
    return {
      nominee_id: Number(row.nominee_id),
      why_chosen: row.why_chosen || '',
      qualities: row.qualities || '',
      achievement: row.achievement || '',
      why_deserving: row.why_deserving || '',
      updated_at: row.updated_at || null,
    };
  }

  // The vote as this person sees it: the window, who they can pick, and the
  // ballot they already sent this month.
  router.get('/current', async (req, res) => {
    try {
      const window = voteWindow();
      const me = req.currentUser;
      const mine = await db.prepare('SELECT * FROM employee_of_month_votes WHERE month = ? AND voter_id = ?').get(window.month, me.id);
      const people = (await roster()).filter((p) => p.id !== Number(me.id));
      res.json({
        window,
        roster: people,
        mine: serializeBallot(mine),
        can_see_results: isHrManager(me),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/vote', async (req, res) => {
    try {
      const window = voteWindow();
      if (!window.open) {
        return res.status(400).json({ error: `Voting for ${window.label} opens ${window.opens_on} and closes ${window.closes_on}.` });
      }
      const me = req.currentUser;
      const body = req.body || {};
      const nomineeId = Number(body.nominee_id);
      if (!Number.isInteger(nomineeId) || nomineeId <= 0) return res.status(400).json({ error: 'Pick the employee you are voting for.' });
      if (nomineeId === Number(me.id)) return res.status(400).json({ error: 'You cannot vote for yourself.' });
      if (!(await roster()).some((p) => p.id === nomineeId)) return res.status(400).json({ error: 'That employee cannot be voted for.' });
      const answers = {};
      for (const field of ANSWER_FIELDS) {
        const value = String(body[field] || '').trim();
        if (!value) return res.status(400).json({ error: 'Every question needs an answer.' });
        answers[field] = value.slice(0, MAX_ANSWER);
      }
      await db.prepare(`
        INSERT INTO employee_of_month_votes (month, voter_id, nominee_id, why_chosen, qualities, achievement, why_deserving)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (month, voter_id) DO UPDATE SET
          nominee_id = excluded.nominee_id,
          why_chosen = excluded.why_chosen,
          qualities = excluded.qualities,
          achievement = excluded.achievement,
          why_deserving = excluded.why_deserving,
          updated_at = CURRENT_TIMESTAMP
      `).run(window.month, me.id, nomineeId, answers.why_chosen, answers.qualities, answers.achievement, answers.why_deserving);
      const mine = await db.prepare('SELECT * FROM employee_of_month_votes WHERE month = ? AND voter_id = ?').get(window.month, me.id);
      res.json({ mine: serializeBallot(mine) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The tally for a month, most votes first, with every ballot's answers.
  router.get('/results', async (req, res) => {
    try {
      const me = req.currentUser;
      if (!isHrManager(me)) return res.status(403).json({ error: 'HR access required' });
      const window = voteWindow();
      const month = MONTH_PATTERN.test(String(req.query?.month || '')) ? String(req.query.month) : window.month;
      const showVoters = Number(me.is_super_admin) === 1;
      const ballots = await db.prepare(`
        SELECT v.*, n.full_name AS nominee_full_name, n.username AS nominee_username,
               u.full_name AS voter_full_name, u.username AS voter_username
        FROM employee_of_month_votes v
        LEFT JOIN users n ON n.id = v.nominee_id
        LEFT JOIN users u ON u.id = v.voter_id
        WHERE v.month = ?
        ORDER BY v.updated_at DESC
      `).all(month);
      const tally = new Map();
      for (const b of ballots) {
        const nomineeId = Number(b.nominee_id);
        if (!tally.has(nomineeId)) {
          tally.set(nomineeId, {
            nominee_id: nomineeId,
            name: personName({ id: nomineeId, full_name: b.nominee_full_name, username: b.nominee_username }),
            votes: 0,
            ballots: [],
          });
        }
        const entry = tally.get(nomineeId);
        entry.votes += 1;
        entry.ballots.push({
          voter: showVoters ? personName({ id: b.voter_id, full_name: b.voter_full_name, username: b.voter_username }) : null,
          why_chosen: b.why_chosen || '',
          qualities: b.qualities || '',
          achievement: b.achievement || '',
          why_deserving: b.why_deserving || '',
          updated_at: b.updated_at || null,
        });
      }
      const months = (await db.prepare('SELECT DISTINCT month FROM employee_of_month_votes ORDER BY month DESC').all())
        .map((r) => r.month);
      if (!months.includes(window.month)) months.unshift(window.month);
      res.json({
        month,
        label: monthLabel(month),
        total_votes: ballots.length,
        results: [...tally.values()].sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name)),
        months: months.map((m) => ({ month: m, label: monthLabel(m) })),
        shows_voters: showVoters,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
