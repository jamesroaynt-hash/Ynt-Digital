const express = require('express');
const { isHrManager } = require('./performance');

// Employee of the Month: everybody votes once a month for one colleague, in
// the last five days of the month (Manila time) — the same five-day stretch
// the second-half Evaluation is filled in. A ballot can be changed until
// voting closes. The tally and the written answers are read by HR, Operation
// and the super admin only (isHrManager); the voters' names by the super
// admin only, like the evaluator names on the peer Evaluation. The questions
// and the month being voted on are set by HR, Operation and the
// Administrators (canEditForm). Schema in db/employeeOfMonthSchema.js.

const MANILA_TIMEZONE = 'Asia/Manila';
const VOTE_DAYS = 5;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ANSWER = 2000;
const MAX_QUESTION = 500;
const MAX_QUESTIONS = 10;

// The paper form. {month} reads as the month being voted on.
const DEFAULT_FORM = {
  month: '',
  nominee_question: 'Who do you believe deserves to be the Employee of the Month for {month}?',
  questions: [
    'Why did you choose this employee as your Employee of the Month?',
    'What qualities or contributions of this employee stood out to you during {month}?',
    'What specific achievement, action, or contribution did you observe from this employee?',
    'Why do you think this employee is deserving of the Employee of the Month recognition?',
  ],
};

// Ballots sent before the questions became editable kept their answers in
// four columns; these are the questions they answered.
const LEGACY_FIELDS = ['why_chosen', 'qualities', 'achievement', 'why_deserving'];

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

function fillMonth(text, label) {
  return String(text || '').replace(/\{month\}/gi, label);
}

// Whether voting is open today, and the month it is for: the running month,
// unless HR picked another one on the form.
function voteWindow(monthOverride = '', today = manilaDate()) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const opensDay = lastDay - (VOTE_DAYS - 1);
  const running = today.slice(0, 7);
  const key = MONTH_PATTERN.test(monthOverride) ? monthOverride : running;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    month: key,
    label: monthLabel(key),
    today,
    opens_on: `${running}-${pad(opensDay)}`,
    closes_on: `${running}-${pad(lastDay)}`,
    open: day >= opensDay,
    days_until_open: Math.max(0, opensDay - day),
  };
}

function personName(row) {
  return row?.full_name || row?.username || `User ${row?.id}`;
}

function canEditForm(user) {
  if (isHrManager(user)) return true;
  const role = String(user?.role || '').trim().toLowerCase();
  return role === 'administrator' || role === 'admin';
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

  // The form as saved, falling back to the paper form for anything unset.
  async function loadForm() {
    const row = await db.prepare('SELECT month, nominee_question, questions FROM employee_of_month_settings WHERE id = 1').get();
    let questions = null;
    try { questions = JSON.parse(row?.questions || 'null'); } catch { questions = null; }
    return {
      month: MONTH_PATTERN.test(row?.month || '') ? row.month : '',
      nominee_question: row?.nominee_question || DEFAULT_FORM.nominee_question,
      questions: Array.isArray(questions) && questions.length ? questions.map(String) : DEFAULT_FORM.questions,
    };
  }

  // A ballot's answers with the questions they answered.
  function ballotAnswers(row, label) {
    try {
      const parsed = JSON.parse(row?.answers || 'null');
      if (Array.isArray(parsed)) return parsed.map((a) => ({ question: String(a?.question || ''), answer: String(a?.answer || '') }));
    } catch { /* fall through to the old columns */ }
    return LEGACY_FIELDS.map((field, i) => ({ question: fillMonth(DEFAULT_FORM.questions[i], label), answer: row?.[field] || '' }));
  }

  function serializeBallot(row, label) {
    if (!row) return null;
    return {
      nominee_id: Number(row.nominee_id),
      answers: ballotAnswers(row, label),
      updated_at: row.updated_at || null,
    };
  }

  // The vote as this person sees it: the window, the form, who they can pick,
  // and the ballot they already sent for that month.
  router.get('/current', async (req, res) => {
    try {
      const form = await loadForm();
      const window = voteWindow(form.month);
      const me = req.currentUser;
      const mine = await db.prepare('SELECT * FROM employee_of_month_votes WHERE month = ? AND voter_id = ?').get(window.month, me.id);
      const people = (await roster()).filter((p) => p.id !== Number(me.id));
      const editable = canEditForm(me);
      res.json({
        window,
        form: {
          nominee_question: fillMonth(form.nominee_question, window.label),
          questions: form.questions.map((q) => fillMonth(q, window.label)),
        },
        // The unfilled texts, for the editor only.
        form_settings: editable ? form : undefined,
        roster: people,
        mine: serializeBallot(mine, window.label),
        can_see_results: isHrManager(me),
        can_edit_form: editable,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const me = req.currentUser;
      if (!canEditForm(me)) return res.status(403).json({ error: 'HR or Administrator access required' });
      const body = req.body || {};
      const month = String(body.month || '').trim();
      if (month && !MONTH_PATTERN.test(month)) return res.status(400).json({ error: 'Month must be YYYY-MM, or empty for the running month.' });
      const nomineeQuestion = String(body.nominee_question || '').trim().slice(0, MAX_QUESTION);
      if (!nomineeQuestion) return res.status(400).json({ error: 'The employee question needs text.' });
      const questions = (Array.isArray(body.questions) ? body.questions : [])
        .map((q) => String(q || '').trim().slice(0, MAX_QUESTION))
        .filter(Boolean);
      if (!questions.length) return res.status(400).json({ error: 'Keep at least one question.' });
      if (questions.length > MAX_QUESTIONS) return res.status(400).json({ error: `At most ${MAX_QUESTIONS} questions.` });
      await db.prepare(`
        INSERT INTO employee_of_month_settings (id, month, nominee_question, questions, updated_by)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          month = excluded.month,
          nominee_question = excluded.nominee_question,
          questions = excluded.questions,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(month || null, nomineeQuestion, JSON.stringify(questions), me.id);
      res.json({ form_settings: await loadForm() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/vote', async (req, res) => {
    try {
      const form = await loadForm();
      const window = voteWindow(form.month);
      if (!window.open) {
        return res.status(400).json({ error: `Voting for ${window.label} opens ${window.opens_on} and closes ${window.closes_on}.` });
      }
      const me = req.currentUser;
      const body = req.body || {};
      const nomineeId = Number(body.nominee_id);
      if (!Number.isInteger(nomineeId) || nomineeId <= 0) return res.status(400).json({ error: 'Pick the employee you are voting for.' });
      if (nomineeId === Number(me.id)) return res.status(400).json({ error: 'You cannot vote for yourself.' });
      if (!(await roster()).some((p) => p.id === nomineeId)) return res.status(400).json({ error: 'That employee cannot be voted for.' });
      const sent = Array.isArray(body.answers) ? body.answers : [];
      const answers = [];
      for (let i = 0; i < form.questions.length; i += 1) {
        const answer = String(sent[i] || '').trim();
        if (!answer) return res.status(400).json({ error: 'Every question needs an answer.' });
        answers.push({ question: fillMonth(form.questions[i], window.label), answer: answer.slice(0, MAX_ANSWER) });
      }
      await db.prepare(`
        INSERT INTO employee_of_month_votes (month, voter_id, nominee_id, why_chosen, qualities, achievement, why_deserving, answers)
        VALUES (?, ?, ?, '', '', '', '', ?)
        ON CONFLICT (month, voter_id) DO UPDATE SET
          nominee_id = excluded.nominee_id,
          why_chosen = '',
          qualities = '',
          achievement = '',
          why_deserving = '',
          answers = excluded.answers,
          updated_at = CURRENT_TIMESTAMP
      `).run(window.month, me.id, nomineeId, JSON.stringify(answers));
      const mine = await db.prepare('SELECT * FROM employee_of_month_votes WHERE month = ? AND voter_id = ?').get(window.month, me.id);
      res.json({ mine: serializeBallot(mine, window.label) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The tally for a month, most votes first, with every ballot's answers.
  router.get('/results', async (req, res) => {
    try {
      const me = req.currentUser;
      if (!isHrManager(me)) return res.status(403).json({ error: 'HR access required' });
      const window = voteWindow((await loadForm()).month);
      const month = MONTH_PATTERN.test(String(req.query?.month || '')) ? String(req.query.month) : window.month;
      const label = monthLabel(month);
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
          answers: ballotAnswers(b, label),
          updated_at: b.updated_at || null,
        });
      }
      const months = (await db.prepare('SELECT DISTINCT month FROM employee_of_month_votes ORDER BY month DESC').all())
        .map((r) => r.month);
      if (!months.includes(window.month)) months.push(window.month);
      months.sort().reverse();
      res.json({
        month,
        label,
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
