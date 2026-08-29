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

// The Evaluation Matrix (General Evaluation) sheet, one for one: four criteria
// worth 25% each, every criterion rated item by item as a percentage. A
// criterion's AVERAGE is the mean of its items; its OVERALL is that average
// against the criterion's total percentage.
const CRITERIA = [
  {
    id: 'communication',
    label: 'Communication Skills',
    weightColumn: 'communication_weight',
    items: [
      { key: 'interaction', label: 'Interaction' },
      { key: 'collab_team_work', label: 'Collab/Team work' },
    ],
  },
  {
    id: 'attitude',
    label: 'Attitude',
    weightColumn: 'attitude_weight',
    items: [
      { key: 'sociability', label: 'Sociability' },
      { key: 'compliance', label: 'Compliance' },
      { key: 'promptness', label: 'Promptness (urgency)' },
      { key: 'commitment', label: 'Commitment' },
      { key: 'initiative', label: 'Initiative' },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    weightColumn: 'skills_weight',
    items: [
      { key: 'rapport', label: 'Rapport w/ Customers' },
      { key: 'proper_opening', label: 'Proper Opening' },
      { key: 'problem_solving', label: 'Problem Solving' },
      { key: 'closing_after_sales', label: 'Closing & After sales' },
      { key: 'get_the_cash', label: 'Get the cash' },
      { key: 'item_knowledge', label: 'Item Knowledge/Product Research' },
      { key: 'follow_up_scripting', label: 'Follow-up & Scripting' },
      { key: 'call_structure', label: 'Call Structure' },
    ],
  },
  {
    id: 'technical',
    label: 'Technical Skills',
    weightColumn: 'technical_weight',
    items: [
      { key: 'google_sheet_tracker', label: 'Google Sheet/Tracker/Inventory' },
      { key: 'creating_response', label: 'Creating Response/ script/spiel' },
      { key: 'basic_troubleshooting', label: 'Basic Troubleshooting' },
      { key: 'facebook_proficiency', label: 'Facebook Proficiency/Pancake/Botcake' },
      { key: 'chat_gpt', label: 'Maximization of chat gpt' },
      { key: 'pages_group', label: 'Familiarity with Pages/Group' },
    ],
  },
];

const PROCEED_VALUES = ['YES', 'NO'];
const PASSED_VALUES = ['PASSED', 'NOT PASSED'];
// The sheet caps the development notes at a thousand words.
const DEVELOPMENT_WORD_LIMIT = 1000;

function isHrManager(user) {
  const role = String(user?.role || '').trim();
  return role === 'Administrator' || role === 'HR';
}

// Item scores are percentages, 0-100. Anything outside that is not a rating.
function normalizePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const percent = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return percent;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function trimmedOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function parseItems(row) {
  try {
    const parsed = JSON.parse(row?.items || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Rows filed under the old star form carry no items. They are not a filled-in
// matrix, so they neither count as submitted nor drag a score down — the
// evaluator is simply asked for the matrix instead.
function hasMatrix(row) {
  return Object.keys(parseItems(row)).length > 0;
}

function pickFromList(value, allowed) {
  const text = String(value ?? '').trim().toUpperCase();
  return allowed.includes(text) ? text : null;
}

module.exports = function evaluationRoutes(db) {
  const router = express.Router();

  async function loadWeights() {
    const row = await db.prepare('SELECT * FROM evaluation_weights WHERE id = 1').get();
    const weights = {};
    CRITERIA.forEach((criterion) => {
      const stored = Number(row?.[criterion.weightColumn]);
      weights[criterion.id] = Number.isFinite(stored) ? stored : 25;
    });
    return weights;
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

  // A subject's matrix is every evaluator's sheet averaged item by item: each
  // item averages across whoever rated it, the criterion averages its rated
  // items, and OVERALL is that average against the criterion's total
  // percentage. A criterion nobody rated earns nothing and is reported as
  // uncovered, so a partial score is never mistaken for a low one.
  function scoreFor(rows, weights) {
    const sheets = rows.filter(hasMatrix).map(parseItems);
    let score = 0;
    let covered = 0;
    const perCriteria = {};

    CRITERIA.forEach((criterion) => {
      const weight = Number(weights[criterion.id] || 0);
      const itemAverages = {};
      const rated = [];
      criterion.items.forEach((item) => {
        const values = sheets
          .map((sheet) => normalizePercent(sheet[item.key]))
          .filter((value) => value !== null);
        if (!values.length) {
          itemAverages[item.key] = null;
          return;
        }
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        itemAverages[item.key] = round(average, 1);
        rated.push(average);
      });

      if (!rated.length) {
        perCriteria[criterion.id] = { weight, average: null, overall: null, items: itemAverages };
        return;
      }
      const average = rated.reduce((sum, value) => sum + value, 0) / rated.length;
      const overall = (average / 100) * weight;
      perCriteria[criterion.id] = {
        weight,
        average: round(average, 1),
        overall: round(overall),
        items: itemAverages,
      };
      score += overall;
      covered += weight;
    });

    return {
      score: round(score),
      covered_weight: round(covered, 1),
      per_criteria: perCriteria,
      responses: sheets.length,
    };
  }

  // Current period, window state, the matrix itself and the weights. Everyone
  // may read this — it carries no scores.
  router.get('/config', async (req, res) => {
    try {
      res.json({
        window: evaluationWindow(),
        weights: await loadWeights(),
        criteria: CRITERIA,
        can_manage: isHrManager(req.user),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/config', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const next = {};
      for (const criterion of CRITERIA) {
        const value = Number(req.body?.[criterion.id]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ error: `Invalid total percentage for ${criterion.label}` });
        }
        next[criterion.id] = round(value, 1);
      }
      const total = CRITERIA.reduce((sum, criterion) => sum + next[criterion.id], 0);
      // A split that does not reach 100 would quietly cap every score below it.
      if (Math.abs(total - 100) > 0.01) {
        return res.status(400).json({ error: `Total percentage must add up to 100% (currently ${round(total, 1)}%)` });
      }
      await db.prepare(`
        UPDATE evaluation_weights
        SET communication_weight = ?, attitude_weight = ?, skills_weight = ?,
            technical_weight = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = 1
      `).run(next.communication, next.attitude, next.skills, next.technical, req.user?.id || null);
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
        const mineForSubject = mineBySubject.get(Number(user.id)) || null;
        const submitted = mineForSubject && hasMatrix(mineForSubject) ? mineForSubject : null;
        const entry = {
          id: user.id,
          name: user.full_name || user.username,
          role: user.role || null,
          submitted: !!submitted,
          // What this evaluator already filled in, so re-opening the sheet is
          // an edit rather than a blank form.
          my_sheet: submitted ? {
            items: parseItems(submitted),
            development_areas: submitted.development_areas || '',
            proceed_to_final: submitted.proceed_to_final || '',
            passed: submitted.passed || '',
            date_evaluated: String(submitted.updated_at || submitted.created_at || '').slice(0, 10),
          } : null,
        };
        if (canSeeScores) {
          entry.result = scoreFor(allBySubject.get(Number(user.id)) || [], weights);
        }
        return entry;
      });

      res.json({ period, window, weights, criteria: CRITERIA, can_see_scores: canSeeScores, data: rows });
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

      // Every item on the sheet has to carry a percentage — a half-filled
      // matrix would average as if the blank items were never part of it.
      const submitted = req.body?.items && typeof req.body.items === 'object' ? req.body.items : {};
      const items = {};
      for (const criterion of CRITERIA) {
        for (const item of criterion.items) {
          const percent = normalizePercent(submitted[item.key]);
          if (percent === null) {
            return res.status(400).json({ error: `Rate "${item.label}" from 0 to 100%.` });
          }
          items[item.key] = percent;
        }
      }

      const development = trimmedOrNull(req.body?.development_areas);
      if (development && development.split(/\s+/).length > DEVELOPMENT_WORD_LIMIT) {
        return res.status(400).json({ error: `Areas that require development is limited to ${DEVELOPMENT_WORD_LIMIT} words.` });
      }

      await db.prepare(`
        INSERT INTO evaluations (
          period, subject_id, evaluator_id, items,
          development_areas, proceed_to_final, passed
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(period, subject_id, evaluator_id) DO UPDATE SET
          items = excluded.items,
          development_areas = excluded.development_areas,
          proceed_to_final = excluded.proceed_to_final,
          passed = excluded.passed,
          updated_at = datetime('now')
      `).run(
        window.period, subjectId, evaluatorId, JSON.stringify(items),
        development,
        pickFromList(req.body?.proceed_to_final, PROCEED_VALUES),
        pickFromList(req.body?.passed, PASSED_VALUES),
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
      res.json({
        period,
        weights,
        criteria: CRITERIA,
        result: scoreFor(rows, weights),
        responses: rows.filter(hasMatrix).map((row) => ({
          evaluator_id: row.evaluator_id,
          evaluator_name: row.evaluator_name || row.evaluator_username,
          items: parseItems(row),
          development_areas: row.development_areas || '',
          proceed_to_final: row.proceed_to_final || '',
          passed: row.passed || '',
          date_evaluated: String(row.updated_at || row.created_at || '').slice(0, 10),
        })),
      });
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
module.exports.CRITERIA = CRITERIA;
