const express = require('express');

const MANILA_TIMEZONE = 'Asia/Manila';

// Everything here is decided in Manila time. The window is only three days
// wide, so reading the date in UTC would open and close it on the wrong day
// for every user.
function manilaDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Periods are calendar months, and the fill-up window is the last three days
// of the month it covers — Aug 29-31 for August, Feb 26-28 in a common year.
function evaluationWindow(today = manilaDate()) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const opensDay = lastDay - 2;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    period: `${year}-${pad(month)}`,
    today,
    opens_on: `${year}-${pad(month)}-${pad(opensDay)}`,
    closes_on: `${year}-${pad(month)}-${pad(lastDay)}`,
    open: day >= opensDay,
    days_until_open: Math.max(0, opensDay - day),
  };
}

const CATEGORIES = [
  { id: 'character', column: 'character_stars', weightColumn: 'character_weight' },
  { id: 'attendance', column: 'attendance_stars', weightColumn: 'attendance_weight' },
  { id: 'eod', column: 'eod_stars', weightColumn: 'eod_weight' },
  { id: 'performance', column: 'performance_stars', weightColumn: 'performance_weight' },
  { id: 'hr', column: 'hr_stars', weightColumn: 'hr_weight' },
];
const PEER_CATEGORIES = CATEGORIES.filter((c) => c.id !== 'hr');

function isHrManager(user) {
  const role = String(user?.role || '').trim();
  return role === 'Administrator' || role === 'HR';
}

function normalizeStars(value) {
  if (value === null || value === undefined || value === '') return null;
  const stars = Math.round(Number(value));
  if (!Number.isFinite(stars) || stars < 1 || stars > 10) return null;
  return stars;
}

function trimmedOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

module.exports = function evaluationRoutes(db) {
  const router = express.Router();

  async function loadWeights() {
    const row = await db.prepare('SELECT * FROM evaluation_weights WHERE id = 1').get();
    return {
      character: Number(row?.character_weight ?? 20),
      attendance: Number(row?.attendance_weight ?? 15),
      eod: Number(row?.eod_weight ?? 15),
      performance: Number(row?.performance_weight ?? 40),
      hr: Number(row?.hr_weight ?? 10),
    };
  }

  // Who can be rated. Administrators are not rated as staff — the same rule
  // payroll already applies when it leaves them off the summary. They still
  // evaluate other people; this is only the list of subjects.
  async function ratableUsers() {
    return db.prepare(`
      SELECT id, full_name, username, role
      FROM users
      WHERE is_active = 1
        AND LOWER(TRIM(COALESCE(role, ''))) NOT IN ('administrator', 'admin')
      ORDER BY full_name COLLATE NOCASE ASC
    `).all();
  }

  // A subject's score is the weighted average of every rating submitted about
  // them. Peer categories average across all evaluators; the HR category is
  // whatever HR entered. A category nobody has rated earns nothing and is
  // reported as uncovered, so a partial score is never mistaken for a low one.
  function scoreFor(rows, weights) {
    let earned = 0;
    let covered = 0;
    const perCategory = {};
    CATEGORIES.forEach((category) => {
      const stars = rows
        .map((row) => normalizeStars(row[category.column]))
        .filter((value) => value !== null);
      const weight = Number(weights[category.id] || 0);
      if (!stars.length) {
        perCategory[category.id] = null;
        return;
      }
      const average = stars.reduce((sum, value) => sum + value, 0) / stars.length;
      perCategory[category.id] = Math.round(average * 10) / 10;
      earned += (average / 10) * weight;
      covered += weight;
    });
    return {
      score: Math.round(earned * 10) / 10,
      covered_weight: Math.round(covered * 10) / 10,
      per_category: perCategory,
      responses: rows.length,
    };
  }

  // Current period, window state and the weights. Everyone may read this —
  // it carries no scores.
  router.get('/config', async (req, res) => {
    try {
      res.json({ window: evaluationWindow(), weights: await loadWeights(), can_manage: isHrManager(req.user) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/config', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const next = {};
      for (const category of CATEGORIES) {
        const value = Number(req.body?.[category.id]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ error: `Invalid weight for ${category.id}` });
        }
        next[category.id] = Math.round(value * 10) / 10;
      }
      const total = CATEGORIES.reduce((sum, category) => sum + next[category.id], 0);
      // A split that does not reach 100 would quietly cap every score below it.
      if (Math.abs(total - 100) > 0.01) {
        return res.status(400).json({ error: `Weights must total 100% (currently ${Math.round(total * 10) / 10}%)` });
      }
      await db.prepare(`
        UPDATE evaluation_weights
        SET character_weight = ?, attendance_weight = ?, eod_weight = ?,
            performance_weight = ?, hr_weight = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = 1
      `).run(next.character, next.attendance, next.eod, next.performance, next.hr, req.user?.id || null);
      res.json({ weights: next });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The signed-in user's queue: everyone they may rate this period, never
  // themselves. Scores ride along only for HR/Administrator.
  router.get('/queue', async (req, res) => {
    try {
      const window = evaluationWindow();
      const period = String(req.query?.period || window.period);
      const viewerId = Number(req.user?.id);
      const canSeeScores = isHrManager(req.user);
      const weights = await loadWeights();

      const users = (await ratableUsers()).filter((user) => Number(user.id) !== viewerId);
      const mine = await db.prepare(`
        SELECT * FROM evaluations WHERE period = ? AND evaluator_id = ?
      `).all(period, viewerId);
      const mineBySubject = new Map(mine.map((row) => [Number(row.subject_id), row]));

      let allBySubject = new Map();
      if (canSeeScores) {
        const all = await db.prepare('SELECT * FROM evaluations WHERE period = ?').all(period);
        all.forEach((row) => {
          const key = Number(row.subject_id);
          if (!allBySubject.has(key)) allBySubject.set(key, []);
          allBySubject.get(key).push(row);
        });
      }

      const rows = users.map((user) => {
        const submitted = mineBySubject.get(Number(user.id)) || null;
        const entry = {
          id: user.id,
          name: user.full_name || user.username,
          role: user.role || null,
          submitted: !!submitted,
          my_rating: submitted ? Object.fromEntries(
            CATEGORIES.map((category) => [category.id, normalizeStars(submitted[category.column])])
          ) : null,
        };
        if (canSeeScores) {
          entry.result = scoreFor(allBySubject.get(Number(user.id)) || [], weights);
        }
        return entry;
      });

      res.json({ period, window, weights, can_see_scores: canSeeScores, data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Submit or revise one evaluation. The window is enforced here, not just in
  // the UI — the three-day rule is the point of the feature.
  router.post('/', async (req, res) => {
    try {
      const window = evaluationWindow();
      if (!window.open) {
        return res.status(409).json({ error: `Evaluation opens ${window.opens_on} and closes ${window.closes_on}.` });
      }
      const evaluatorId = Number(req.user?.id);
      const subjectId = Number(req.body?.subject_id);
      if (!Number.isFinite(subjectId) || subjectId <= 0) return res.status(400).json({ error: 'Invalid subject' });
      if (subjectId === evaluatorId) return res.status(400).json({ error: 'You cannot evaluate yourself.' });

      const subject = await db.prepare(`
        SELECT id FROM users
        WHERE id = ? AND is_active = 1
          AND LOWER(TRIM(COALESCE(role, ''))) NOT IN ('administrator', 'admin')
      `).get(subjectId);
      if (!subject) return res.status(404).json({ error: 'Employee not found' });

      const canRateHr = isHrManager(req.user);
      const values = {};
      for (const category of PEER_CATEGORIES) {
        const stars = normalizeStars(req.body?.[category.id]);
        if (stars === null) return res.status(400).json({ error: `Rate ${category.id} from 1 to 10 stars.` });
        values[category.column] = stars;
      }
      // Only HR/Administrator carry the Final Rate HR category; a peer's
      // submission simply leaves it unrated for HR to fill in later.
      values.hr_stars = canRateHr ? normalizeStars(req.body?.hr) : null;
      if (canRateHr && values.hr_stars === null) {
        return res.status(400).json({ error: 'Rate Final Rate HR from 1 to 10 stars.' });
      }

      await db.prepare(`
        INSERT INTO evaluations (
          period, subject_id, evaluator_id,
          character_stars, attendance_stars, eod_stars, performance_stars, hr_stars,
          hr_comments, employee_comments, recommendation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(period, subject_id, evaluator_id) DO UPDATE SET
          character_stars = excluded.character_stars,
          attendance_stars = excluded.attendance_stars,
          eod_stars = excluded.eod_stars,
          performance_stars = excluded.performance_stars,
          hr_stars = excluded.hr_stars,
          hr_comments = excluded.hr_comments,
          employee_comments = excluded.employee_comments,
          recommendation = excluded.recommendation,
          updated_at = datetime('now')
      `).run(
        window.period, subjectId, evaluatorId,
        values.character_stars, values.attendance_stars, values.eod_stars,
        values.performance_stars, values.hr_stars,
        trimmedOrNull(req.body?.hr_comments),
        trimmedOrNull(req.body?.employee_comments),
        trimmedOrNull(req.body?.recommendation),
      );

      res.json({ saved: true, period: window.period, subject_id: subjectId });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Full result for one employee, scores included — HR/Administrator only.
  router.get('/summary/:subjectId', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const window = evaluationWindow();
      const period = String(req.query?.period || window.period);
      const subjectId = Number(req.params.subjectId);
      const weights = await loadWeights();
      const rows = await db.prepare(`
        SELECT e.*, u.full_name AS evaluator_name, u.username AS evaluator_username
        FROM evaluations e
        JOIN users u ON u.id = e.evaluator_id
        WHERE e.period = ? AND e.subject_id = ?
        ORDER BY e.updated_at DESC
      `).all(period, subjectId);
      res.json({ period, weights, result: scoreFor(rows, weights), responses: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Every period this employee has been rated in, for the record card.
  router.get('/history/:subjectId', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const subjectId = Number(req.params.subjectId);
      const weights = await loadWeights();
      const rows = await db.prepare(
        'SELECT * FROM evaluations WHERE subject_id = ? ORDER BY period DESC'
      ).all(subjectId);
      const byPeriod = new Map();
      rows.forEach((row) => {
        if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
        byPeriod.get(row.period).push(row);
      });
      res.json({
        data: [...byPeriod.entries()].map(([period, periodRows]) => ({
          period,
          ...scoreFor(periodRows, weights),
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports.evaluationWindow = evaluationWindow;
