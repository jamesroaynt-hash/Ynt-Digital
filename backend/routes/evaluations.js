const express = require('express');

const MANILA_TIMEZONE = 'Asia/Manila';

// Administrator, HR and Operation all manage HR: Operation was granted HR's
// access, so it clears every gate HR clears. Role text is typed by hand on
// accounts, hence the lowercase compare and the plural spelling.
const HR_MANAGER_ROLES = new Set(['administrator', 'hr', 'operation', 'operations']);

// The fill-up window is the last five days of the period it covers.
const FILL_DAYS = 5;

// Everything here is decided in Manila time. The window is only five days
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

// Periods run every fifteen days — the 1st to the 15th, then the 16th to the
// end of the month — and each one is filled in over its last five days: the
// 11th-15th, then the five days to the month's end. HR and the Administrator
// are not held to that window; everybody else writes inside it.
function evaluationWindow(today = manilaDate()) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const half = day <= 15 ? 1 : 2;
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : lastDay;
  // A short February still leaves its second half at least five days wide, so
  // the window never reaches back past the 16th.
  const opensDay = Math.max(startDay, endDay - (FILL_DAYS - 1));
  const pad = (n) => String(n).padStart(2, '0');
  const on = (dayOfMonth) => `${year}-${pad(month)}-${pad(dayOfMonth)}`;
  return {
    period: `${year}-${pad(month)}-H${half}`,
    half,
    today,
    starts_on: on(startDay),
    opens_on: on(opensDay),
    closes_on: on(endDay),
    open: day >= opensDay,
    days_until_open: Math.max(0, opensDay - day),
    fill_days: FILL_DAYS,
  };
}

// The day before a date, as YYYY-MM-DD.
function previousDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// The window with HR's extension applied. An extension keeps one period open
// for everybody until its date: inside that period it only pushes the closing
// day out, and after the period has ended it keeps that period the one being
// filled — instead of rolling over to the next period, whose own window has not
// opened yet — until the extension runs out. extension = { period, until }.
function windowWithExtension(extension, today = manilaDate()) {
  const base = evaluationWindow(today);
  const until = extension?.until;
  if (!extension?.period || !until || until < today) return { ...base, extended_until: null };
  if (extension.period === base.period) {
    return {
      ...base,
      open: base.open || today >= base.opens_on,
      closes_on: until > base.closes_on ? until : base.closes_on,
      extended_until: until,
    };
  }
  // The extension is for the period that just ended; the running one has not
  // opened, so the ended one stays open until the extension's date.
  const previous = evaluationWindow(previousDay(base.starts_on));
  if (extension.period === previous.period && !base.open) {
    return {
      ...previous,
      today,
      open: true,
      days_until_open: 0,
      closes_on: until,
      extended_until: until,
    };
  }
  return { ...base, extended_until: null };
}

// Half-month periods, and the whole-month ones the sheets were filed under
// before the period was split in two.
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])(-H[12])?$/;

function validPeriod(value, fallback) {
  const text = String(value || '').trim();
  return PERIOD_PATTERN.test(text) ? text : fallback;
}

// The Evaluation Matrix (General Evaluation) sheet, one for one: four criteria
// worth 25% each, every criterion rated item by item as a percentage. A
// criterion's AVERAGE is the mean of its items; its OVERALL is that average
// against the criterion's total percentage. These are only the starting rows —
// HR and the Administrator edit the item list from the page, and the database
// is what the sheet is built from once it has been seeded.
const DEFAULT_CRITERIA = [
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
// The score an employee has to reach to pass, until HR sets its own.
const DEFAULT_PASSING_SCORE = 75;
const ITEM_LABEL_LIMIT = 120;
const MAX_ITEMS_PER_CRITERION = 40;

function isHrManager(user) {
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

function isAdministrator(user) {
  return ['administrator', 'admin'].includes(String(user?.role || '').trim().toLowerCase());
}

// Everyone rates everyone: the sheets are peer evaluations, so any account may
// write one. What HR and the Administrator have that the rest do not is the
// scores, the matrix itself, and a sheet they can fill in outside the window.
function canEvaluate(user) {
  return !!Number(user?.id);
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

// A new item row is filed under a key made from its wording. The key is what
// every sheet's scores are stored against, so it is set once and never
// rewritten — renaming the row later leaves it alone.
function itemKeyFrom(label, taken) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
  let key = base;
  let suffix = 2;
  while (taken.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  return key;
}

module.exports = function evaluationRoutes(db) {
  const router = express.Router();

  // The matrix starts as the printed sheet: the rows above are written into
  // the table the first time anybody reads it, and edited from the page after
  // that. Only an empty table is seeded, so a row HR deleted stays deleted.
  let itemsSeeded = false;
  async function ensureItemsSeeded() {
    if (itemsSeeded) return;
    const row = await db.prepare('SELECT COUNT(*) AS count FROM evaluation_items').get();
    if (!Number(row?.count || 0)) {
      for (const criterion of DEFAULT_CRITERIA) {
        let position = 0;
        for (const item of criterion.items) {
          await db.prepare(`
            INSERT INTO evaluation_items (criterion_id, item_key, label, position)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(item_key) DO NOTHING
          `).run(criterion.id, item.key, item.label, position);
          position += 1;
        }
      }
    }
    itemsSeeded = true;
  }

  // The fill-up window as everybody sees it, HR's extension included.
  async function currentWindow() {
    const row = await db.prepare(
      'SELECT extended_period, extended_until FROM evaluation_weights WHERE id = 1'
    ).get();
    return windowWithExtension({ period: row?.extended_period, until: row?.extended_until });
  }

  // The sheet as it stands: the four criteria with what each is worth, the
  // item rows under them, and the score an employee has to reach to pass.
  async function loadConfig() {
    await ensureItemsSeeded();
    const row = await db.prepare('SELECT * FROM evaluation_weights WHERE id = 1').get();
    const weights = {};
    DEFAULT_CRITERIA.forEach((criterion) => {
      const stored = Number(row?.[criterion.weightColumn]);
      weights[criterion.id] = Number.isFinite(stored) ? stored : 25;
    });
    const storedPass = Number(row?.passing_score);
    const passingScore = Number.isFinite(storedPass) && storedPass >= 0 && storedPass <= 100
      ? round(storedPass, 1)
      : DEFAULT_PASSING_SCORE;

    const items = await db.prepare(`
      SELECT criterion_id, item_key, label
      FROM evaluation_items
      WHERE is_active = 1
      ORDER BY position ASC, id ASC
    `).all();
    const byCriterion = new Map();
    items.forEach((item) => {
      if (!byCriterion.has(item.criterion_id)) byCriterion.set(item.criterion_id, []);
      byCriterion.get(item.criterion_id).push({ key: item.item_key, label: item.label });
    });

    return {
      weights,
      passing_score: passingScore,
      criteria: DEFAULT_CRITERIA.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        weight: weights[criterion.id],
        items: byCriterion.get(criterion.id) || [],
      })),
    };
  }

  // The item rows, saved as the editor left them. A row that came back with
  // its key keeps that key, so the scores already filed under it still line
  // up; a row the editor dropped is deactivated rather than deleted, so the
  // sheets that rated it keep what they hold. Criteria the payload leaves out
  // are not touched.
  async function saveItems(payload) {
    const existing = await db.prepare(
      'SELECT id, criterion_id, item_key, is_active FROM evaluation_items'
    ).all();
    const byKey = new Map(existing.map((row) => [row.item_key, row]));
    const taken = new Set(existing.map((row) => row.item_key));

    // Nothing is written until the whole payload reads as a matrix, so a bad
    // row cannot leave the sheet half-edited.
    const plan = [];
    for (const criterion of DEFAULT_CRITERIA) {
      const list = payload[criterion.id];
      if (!Array.isArray(list)) continue;
      if (!list.length) throw new Error(`${criterion.label} needs at least one item.`);
      if (list.length > MAX_ITEMS_PER_CRITERION) {
        throw new Error(`${criterion.label} is limited to ${MAX_ITEMS_PER_CRITERION} items.`);
      }
      const labels = new Set();
      const rows = list.map((entry) => {
        const label = String(entry?.label ?? '').trim();
        if (!label) throw new Error(`Every item under ${criterion.label} needs a name.`);
        if (label.length > ITEM_LABEL_LIMIT) {
          throw new Error(`An item name is longer than ${ITEM_LABEL_LIMIT} characters.`);
        }
        if (labels.has(label.toLowerCase())) {
          throw new Error(`${criterion.label} lists "${label}" twice.`);
        }
        labels.add(label.toLowerCase());
        const key = String(entry?.key ?? '').trim();
        return { label, row: key ? byKey.get(key) : null };
      });
      plan.push({ criterion, rows });
    }

    const kept = new Set();
    for (const { criterion, rows } of plan) {
      let position = 0;
      for (const { label, row } of rows) {
        if (row) {
          kept.add(row.item_key);
          await db.prepare(`
            UPDATE evaluation_items
            SET criterion_id = ?, label = ?, position = ?, is_active = 1
            WHERE id = ?
          `).run(criterion.id, label, position, row.id);
        } else {
          const key = itemKeyFrom(label, taken);
          taken.add(key);
          kept.add(key);
          await db.prepare(`
            INSERT INTO evaluation_items (criterion_id, item_key, label, position)
            VALUES (?, ?, ?, ?)
          `).run(criterion.id, key, label, position);
        }
        position += 1;
      }
    }

    // Whatever the editor dropped from a criterion it did send.
    const edited = new Set(plan.map(({ criterion }) => criterion.id));
    for (const row of existing) {
      if (!edited.has(row.criterion_id) || kept.has(row.item_key) || !Number(row.is_active)) continue;
      await db.prepare('UPDATE evaluation_items SET is_active = 0 WHERE id = ?').run(row.id);
    }
  }

  // Who can be rated: every active account, administrators included, except
  // trainees — they are still in training and are not on the list — and
  // anybody the Administrator took off it (users.exclude_from_evaluation).
  // Taken off the list only stops them being rated; they still rate others.
  async function ratableUsers({ excluded = false } = {}) {
    return db.prepare(`
      SELECT id, full_name, username, role
      FROM users
      WHERE is_active = 1
        AND LOWER(TRIM(COALESCE(role, ''))) <> 'trainee'
        AND COALESCE(exclude_from_evaluation, 0) = ?
      ORDER BY full_name COLLATE NOCASE ASC
    `).all(excluded ? 1 : 0);
  }

  // A subject's matrix is every evaluator's sheet averaged item by item: each
  // item averages across whoever rated it, the criterion averages its rated
  // items, and OVERALL is that average against the criterion's total
  // percentage. A criterion nobody rated earns nothing and is reported as
  // uncovered, so a partial score is never mistaken for a low one.
  function scoreFor(rows, config) {
    const sheets = rows.filter(hasMatrix).map(parseItems);
    let score = 0;
    let covered = 0;
    const perCriteria = {};

    config.criteria.forEach((criterion) => {
      const weight = Number(criterion.weight || 0);
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

    const total = round(score);
    return {
      score: total,
      covered_weight: round(covered, 1),
      per_criteria: perCriteria,
      responses: sheets.length,
      passing_score: config.passing_score,
      // Nobody has rated them yet, so there is nothing to pass or fail.
      passed: sheets.length ? total >= config.passing_score : null,
    };
  }

  // Every sheet written about one employee in a period, scored. Evaluators are
  // anonymous unless showNames is set — only for an Administrator reading
  // somebody else's sheets (see /summary). When it is not set the name never
  // leaves the server, so it cannot be read out of the network tab either.
  // showDates is off for an employee reading their own sheets: when a sheet
  // was filed can be enough to tell who filed it.
  async function summaryFor(subjectId, period, config, { showNames = false, showDates = true } = {}) {
    const rows = await db.prepare(`
      SELECT e.*, u.full_name AS evaluator_full_name, u.username AS evaluator_username
      FROM evaluations e
      LEFT JOIN users u ON u.id = e.evaluator_id
      WHERE e.period = ? AND e.subject_id = ?
      ORDER BY e.updated_at DESC
    `).all(period, subjectId);
    return {
      period,
      weights: config.weights,
      passing_score: config.passing_score,
      criteria: config.criteria,
      result: scoreFor(rows, config),
      anonymous: !showNames,
      responses: rows.filter(hasMatrix).map((row, index) => ({
        // Numbered by the order they come back in, which shifts as sheets are
        // revised — nothing to line up across periods.
        evaluator_label: `Evaluator ${index + 1}`,
        ...(showNames ? {
          // The sheet's id rides along with the name, so the Administrator
          // can cancel one — never on the anonymous views.
          id: row.id,
          evaluator_name: row.evaluator_full_name || row.evaluator_username || `Evaluator ${index + 1}`,
        } : {}),
        items: parseItems(row),
        // This one sheet scored on its own, so HR can open a single
        // evaluation and read the same matrix the average is built from.
        result: scoreFor([row], config),
        development_areas: row.development_areas || '',
        proceed_to_final: row.proceed_to_final || '',
        passed: row.passed || '',
        ...(showDates ? {
          date_evaluated: String(row.updated_at || row.created_at || '').slice(0, 10),
        } : {}),
      })),
    };
  }

  // Current period, window state, the matrix itself, the weights and the
  // passing score. Everyone may read this — it carries no scores.
  router.get('/config', async (req, res) => {
    try {
      const config = await loadConfig();
      res.json({
        window: await currentWindow(),
        ...config,
        can_manage: isHrManager(req.user),
        can_evaluate: canEvaluate(req.user),
        // HR and the Administrator write sheets whenever they need to; the
        // five-day window is everybody else's.
        can_fill_anytime: isHrManager(req.user),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The matrix setup: what each criteria is worth, the score that passes, and
  // the item rows themselves. HR and the Administrator only.
  router.put('/config', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      // The weights came flat on the body before the setup card carried the
      // items and the passing score with them; both shapes still read.
      const weights = req.body?.weights && typeof req.body.weights === 'object' ? req.body.weights : req.body;
      const next = {};
      for (const criterion of DEFAULT_CRITERIA) {
        const value = Number(weights?.[criterion.id]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ error: `Invalid total percentage for ${criterion.label}` });
        }
        next[criterion.id] = round(value, 1);
      }
      const total = DEFAULT_CRITERIA.reduce((sum, criterion) => sum + next[criterion.id], 0);
      // A split that does not reach 100 would quietly cap every score below it.
      if (Math.abs(total - 100) > 0.01) {
        return res.status(400).json({ error: `Total percentage must add up to 100% (currently ${round(total, 1)}%)` });
      }

      const rawPass = req.body?.passing_score;
      const passingScore = rawPass === undefined || rawPass === null || rawPass === ''
        ? DEFAULT_PASSING_SCORE
        : Number(rawPass);
      if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100) {
        return res.status(400).json({ error: 'The passing score is a percentage from 0 to 100.' });
      }

      if (req.body?.items && typeof req.body.items === 'object') {
        await saveItems(req.body.items);
      }

      await db.prepare(`
        UPDATE evaluation_weights
        SET communication_weight = ?, attitude_weight = ?, skills_weight = ?,
            technical_weight = ?, passing_score = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = 1
      `).run(
        next.communication, next.attitude, next.skills, next.technical,
        round(passingScore, 1), req.user?.id || null,
      );
      res.json(await loadConfig());
    } catch (error) {
      // A rejected matrix is the editor's to fix, not a server fault.
      res.status(400).json({ error: error.message });
    }
  });

  // Extend the fill-up window — HR and the Administrator only. The extension
  // belongs to the period being filled now (or the one that just closed, when
  // the running one has not opened yet), and an empty date clears it.
  router.put('/extension', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const raw = String(req.body?.until || '').trim();
      if (!raw) {
        await db.prepare(`
          UPDATE evaluation_weights
          SET extended_period = NULL, extended_until = NULL, updated_by = ?, updated_at = datetime('now')
          WHERE id = 1
        `).run(req.user?.id || null);
        return res.json({ window: await currentWindow() });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        return res.status(400).json({ error: 'Pick a valid extension date.' });
      }
      const today = manilaDate();
      const base = evaluationWindow(today);
      const target = base.open ? base : evaluationWindow(previousDay(base.starts_on));
      if (raw < today) return res.status(400).json({ error: 'The extension date cannot be in the past.' });
      if (raw <= target.closes_on) {
        return res.status(400).json({ error: `Pick a date after ${target.closes_on}, when the window normally closes.` });
      }
      await db.prepare(`
        UPDATE evaluation_weights
        SET extended_period = ?, extended_until = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = 1
      `).run(target.period, raw, req.user?.id || null);
      res.json({ window: await currentWindow() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // The queue: everyone this user may rate this period, never themselves.
  // Scores ride along only for HR/Administrator — the rest fill their sheets
  // in without ever seeing what anybody scored.
  router.get('/queue', async (req, res) => {
    try {
      const window = await currentWindow();
      const period = validPeriod(req.query?.period, window.period);
      const viewerId = Number(req.user?.id);
      const canSeeScores = isHrManager(req.user);
      const config = await loadConfig();

      const users = (await ratableUsers()).filter((user) => Number(user.id) !== viewerId);
      const mine = await db.prepare(`
        SELECT * FROM evaluations WHERE period = ? AND evaluator_id = ?
      `).all(period, viewerId);
      const mineBySubject = new Map(mine.map((row) => [Number(row.subject_id), row]));

      let allBySubject = new Map();
      // Every period anybody filed sheets under, plus the running one, so HR
      // can read a period after the window has rolled past it.
      let periods = [];
      if (canSeeScores) {
        const filed = await db.prepare('SELECT DISTINCT period FROM evaluations').all();
        periods = [...new Set([window.period, period, ...filed.map((row) => row.period)])]
          .filter((value) => PERIOD_PATTERN.test(String(value || '')))
          .sort()
          .reverse();
      }
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
          entry.result = scoreFor(allBySubject.get(Number(user.id)) || [], config);
        }
        return entry;
      });

      res.json({
        period,
        window,
        ...config,
        can_see_scores: canSeeScores,
        can_evaluate: canEvaluate(req.user),
        can_fill_anytime: isHrManager(req.user),
        periods,
        // Who the Administrator took off the list, so they can be put back.
        excluded: isAdministrator(req.user)
          ? (await ratableUsers({ excluded: true })).map((user) => ({
            id: user.id, name: user.full_name || user.username, role: user.role || null,
          }))
          : [],
        can_exclude: isAdministrator(req.user),
        data: rows,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Submit or revise one evaluation. Anybody may write one about anybody else,
  // and the five-day window is enforced here rather than only in the UI — HR
  // and the Administrator are the only ones who write outside it.
  router.post('/', async (req, res) => {
    if (!canEvaluate(req.user)) {
      return res.status(403).json({ error: 'Sign in to submit an evaluation.' });
    }
    try {
      const window = await currentWindow();
      const anytime = isHrManager(req.user);
      if (!window.open && !anytime) {
        return res.status(409).json({
          error: `Evaluation opens ${window.opens_on} and closes ${window.closes_on}.`,
        });
      }
      // Only HR and the Administrator may file a sheet against a period other
      // than the one running — for everybody else the window is the period.
      const period = anytime ? validPeriod(req.body?.period, window.period) : window.period;
      const evaluatorId = Number(req.user?.id);
      const subjectId = Number(req.body?.subject_id);
      if (!Number.isFinite(subjectId) || subjectId <= 0) return res.status(400).json({ error: 'Invalid subject' });
      if (subjectId === evaluatorId) return res.status(400).json({ error: 'You cannot evaluate yourself.' });

      const subject = await db.prepare(`
        SELECT id FROM users
        WHERE id = ? AND is_active = 1
          AND LOWER(TRIM(COALESCE(role, ''))) <> 'trainee'
          AND COALESCE(exclude_from_evaluation, 0) = 0
      `).get(subjectId);
      if (!subject) return res.status(404).json({ error: 'Employee not found' });

      // Every item on the sheet has to carry a percentage — a half-filled
      // matrix would average as if the blank items were never part of it.
      const config = await loadConfig();
      const submitted = req.body?.items && typeof req.body.items === 'object' ? req.body.items : {};
      const items = {};
      for (const criterion of config.criteria) {
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
        period, subjectId, evaluatorId, JSON.stringify(items),
        development,
        pickFromList(req.body?.proceed_to_final, PROCEED_VALUES),
        pickFromList(req.body?.passed, PASSED_VALUES),
      );

      res.json({ saved: true, period, subject_id: subjectId });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Full result for one employee, scores included — HR/Administrator only.
  // An Administrator also sees who wrote each sheet, except on the sheets
  // written about themselves; HR and Operation never see names.
  router.get('/summary/:subjectId', async (req, res) => {
    if (!isHrManager(req.user)) return res.status(403).json({ error: 'HR or Administrator access required' });
    try {
      const window = await currentWindow();
      const period = validPeriod(req.query?.period, window.period);
      const subjectId = Number(req.params.subjectId);
      const showNames = isAdministrator(req.user) && subjectId !== Number(req.user?.id);
      res.json(await summaryFor(subjectId, period, await loadConfig(), { showNames }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Take somebody off the list of people rated, or put them back. The
  // Administrator only. Sheets already filed about them are left as they are.
  router.put('/exclusion', async (req, res) => {
    if (!isAdministrator(req.user)) return res.status(403).json({ error: 'Administrator access required' });
    try {
      const userId = Number(req.body?.user_id);
      if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user' });
      const excluded = req.body?.excluded ? 1 : 0;
      const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      await db.prepare('UPDATE users SET exclude_from_evaluation = ? WHERE id = ?').run(excluded, userId);
      res.json({ saved: true, user_id: userId, excluded: !!excluded });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Reset a whole period: every sheet filed under it is deleted, so it starts
  // over empty. The Administrator only.
  router.delete('/period/:period', async (req, res) => {
    if (!isAdministrator(req.user)) return res.status(403).json({ error: 'Administrator access required' });
    try {
      const period = validPeriod(req.params.period, '');
      if (!period) return res.status(400).json({ error: 'Invalid period' });
      const count = await db.prepare('SELECT COUNT(*) AS n FROM evaluations WHERE period = ?').get(period);
      await db.prepare('DELETE FROM evaluations WHERE period = ?').run(period);
      res.json({ deleted: Number(count?.n || 0), period });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Cancel one sheet — the Administrator only, and never one written about
  // themselves. It is deleted outright, so the employee's average for that
  // period is rebuilt from the sheets that are left.
  router.delete('/:id', async (req, res) => {
    if (!isAdministrator(req.user)) return res.status(403).json({ error: 'Administrator access required' });
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid evaluation' });
      const row = await db.prepare('SELECT id, subject_id, period FROM evaluations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Evaluation not found' });
      if (Number(row.subject_id) === Number(req.user?.id)) {
        return res.status(403).json({ error: 'You cannot cancel an evaluation written about you.' });
      }
      await db.prepare('DELETE FROM evaluations WHERE id = ?').run(id);
      res.json({ deleted: true, id, period: row.period, subject_id: row.subject_id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // What was written about the signed-in user: their own evaluation, and
  // nobody else's. Everybody reads their own sheets and score; the evaluators
  // are never named here, Administrator included, so the names never leave the
  // server. With no ?period= it shows the running period, or — once the window
  // has rolled past the last filled period — the latest one with sheets, so
  // the card is not blank for the half-month before the next window opens.
  router.get('/me', async (req, res) => {
    try {
      const window = await currentWindow();
      const viewerId = Number(req.user?.id);
      const config = await loadConfig();
      const history = await db.prepare(
        'SELECT * FROM evaluations WHERE subject_id = ? ORDER BY period DESC'
      ).all(viewerId);
      const byPeriod = new Map();
      history.forEach((row) => {
        if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
        byPeriod.get(row.period).push(row);
      });
      const rated = [...byPeriod.entries()]
        .filter(([, rows]) => rows.some(hasMatrix))
        .map(([historyPeriod]) => historyPeriod)
        .filter((value) => PERIOD_PATTERN.test(String(value || '')))
        .sort()
        .reverse();

      let period = validPeriod(req.query?.period, '');
      if (!period) {
        const latest = rated.find((value) => value <= window.period);
        period = (byPeriod.get(window.period) || []).some(hasMatrix) || !latest ? window.period : latest;
      }

      const summary = await summaryFor(viewerId, period, config, { showDates: isHrManager(req.user) });
      res.json({
        ...summary,
        window,
        can_evaluate: canEvaluate(req.user),
        can_fill_anytime: isHrManager(req.user),
        periods: [...new Set([window.period, period, ...rated])].sort().reverse(),
        history: [...byPeriod.entries()].map(([historyPeriod, periodRows]) => ({
          period: historyPeriod,
          ...scoreFor(periodRows, config),
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Every period this employee has been rated in, for the record card.
  router.get('/history/:subjectId', async (req, res) => {
    const subjectId = Number(req.params.subjectId);
    // HR reads anybody's record; everyone else only their own.
    if (!isHrManager(req.user) && subjectId !== Number(req.user?.id)) {
      return res.status(403).json({ error: 'HR or Administrator access required' });
    }
    try {
      const config = await loadConfig();
      const rows = await db.prepare(
        'SELECT * FROM evaluations WHERE subject_id = ? ORDER BY period DESC'
      ).all(subjectId);
      const byPeriod = new Map();
      rows.forEach((row) => {
        if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
        byPeriod.get(row.period).push(row);
      });
      res.json({
        passing_score: config.passing_score,
        data: [...byPeriod.entries()].map(([period, periodRows]) => ({
          period,
          ...scoreFor(periodRows, config),
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports.evaluationWindow = evaluationWindow;
module.exports.windowWithExtension = windowWithExtension;
module.exports.DEFAULT_CRITERIA = DEFAULT_CRITERIA;
