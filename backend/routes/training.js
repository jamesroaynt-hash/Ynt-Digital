const crypto = require('crypto');
const express = require('express');

// Training Center. Every active account is a learner; HR, Operation and the
// super admin also author trainings and read everyone's progress (the same
// gate as the rest of HR).
//
// Quizzes are scored here, never in the browser: a learner's copy of a
// training has its answer keys stripped, and a result only says which
// questions were wrong — not what the right answers were — so a quiz cannot
// be passed by reading the network tab or by passing answers around.
const HR_MANAGER_ROLES = new Set(['hr', 'operation', 'operations']);

// Departments come from the account's role, the same table the frontend uses
// for the Employee Tracker (DEPARTMENT_BY_ROLE in app.js).
const DEPARTMENT_BY_ROLE = {
  administrator: 'Management',
  admin: 'Management',
  hr: 'Human Resources',
  operation: 'Operations',
  operations: 'Operations',
  'sales and marketing': 'Sales & Marketing',
  'sales & marketing': 'Sales & Marketing',
  'sales and marketing tl': 'Sales & Marketing',
  'sales & marketing tl': 'Sales & Marketing',
  csr: 'CSR',
  'csr tl': 'CSR',
  rmo: 'RMO',
  'rmo tl': 'RMO',
  logistics: 'Logistics',
  trainee: 'Trainee',
};

function departmentOf(user) {
  return DEPARTMENT_BY_ROLE[String(user?.role || '').trim().toLowerCase().replace(/\s+/g, ' ')] || 'Unassigned';
}

function isManager(user) {
  if (Number(user?.is_super_admin) === 1) return true;
  return HR_MANAGER_ROLES.has(String(user?.role || '').trim().toLowerCase());
}

function parse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function text(value, max = 2000) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, max) : null;
}

function date(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function int(value, fallback, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function newId(prefix) {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

function manilaToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// Normalise what an author sent into the stored shape. Ids are kept when sent
// so a learner's finished lessons survive an edit of the training.
function cleanTraining(body) {
  const lessons = (Array.isArray(body.lessons) ? body.lessons : [])
    .map((lesson) => ({
      id: text(lesson?.id, 40) || newId('l'),
      title: text(lesson?.title, 200),
      url: text(lesson?.url, 1000),
      minutes: int(lesson?.minutes, 0, 0, 1000),
    }))
    .filter((lesson) => lesson.title || lesson.url)
    .map((lesson) => ({ ...lesson, title: lesson.title || 'Lesson' }));
  const materials = (Array.isArray(body.materials) ? body.materials : [])
    .map((item) => ({ name: text(item?.name, 200), url: text(item?.url, 1000) }))
    .filter((item) => item.url)
    .map((item) => ({ ...item, name: item.name || 'Material' }));
  const quiz = (Array.isArray(body.quiz) ? body.quiz : [])
    .map((q) => {
      const type = ['multiple_choice', 'true_false', 'short_answer'].includes(q?.type) ? q.type : 'multiple_choice';
      const options = type === 'multiple_choice'
        ? (Array.isArray(q?.options) ? q.options : []).map((option) => text(option, 300)).filter(Boolean)
        : type === 'true_false' ? ['True', 'False'] : [];
      return {
        id: text(q?.id, 40) || newId('q'),
        type,
        question: text(q?.question, 1000),
        options,
        answer: text(q?.answer, 300),
        points: int(q?.points, 1, 1, 100),
      };
    })
    .filter((q) => q.question && q.answer && (q.type !== 'multiple_choice' || q.options.includes(q.answer)));
  const audienceIn = body.audience || {};
  const audience = audienceIn.all
    ? { all: true }
    : {
      departments: (Array.isArray(audienceIn.departments) ? audienceIn.departments : []).map((d) => text(d, 60)).filter(Boolean),
      user_ids: (Array.isArray(audienceIn.user_ids) ? audienceIn.user_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    };
  return {
    title: text(body.title, 200),
    description: text(body.description, 4000),
    category: text(body.category, 80),
    instructions: text(body.instructions, 4000),
    lessons: JSON.stringify(lessons),
    materials: JSON.stringify(materials),
    quiz: JSON.stringify(quiz),
    passing_score: int(body.passing_score, 80, 1, 100),
    estimated_minutes: int(body.estimated_minutes, lessons.reduce((sum, l) => sum + l.minutes, 0), 0, 10000),
    audience: JSON.stringify(audience),
    required: body.required ? 1 : 0,
    due_date: date(body.due_date),
    status: body.status === 'published' ? 'published' : 'draft',
  };
}

function inAudience(training, user) {
  const audience = training.audience || {};
  if (audience.all) return true;
  if ((audience.user_ids || []).map(Number).includes(Number(user.id))) return true;
  return (audience.departments || []).includes(departmentOf(user));
}

// The row as the API returns it. withKey is for authors only.
function shapeTraining(row, { withKey = false } = {}) {
  const quiz = parse(row.quiz, []);
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    category: row.category || '',
    instructions: row.instructions || '',
    lessons: parse(row.lessons, []),
    materials: parse(row.materials, []),
    quiz: withKey ? quiz : quiz.map(({ answer, ...q }) => q),
    quiz_points: quiz.reduce((sum, q) => sum + Number(q.points || 1), 0),
    passing_score: Number(row.passing_score || 80),
    estimated_minutes: Number(row.estimated_minutes || 0),
    audience: parse(row.audience, { all: true }),
    required: Number(row.required) === 1,
    due_date: row.due_date || null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapeProgress(row) {
  if (!row) return null;
  return {
    status: row.status,
    lessons_done: parse(row.lessons_done, []),
    notes: row.notes || '',
    attempts: Number(row.attempts || 0),
    last_score: row.last_score === null || row.last_score === undefined ? null : Number(row.last_score),
    best_score: row.best_score === null || row.best_score === undefined ? null : Number(row.best_score),
    last_result: parse(row.last_result, null),
    started_at: row.started_at,
    completed_at: row.completed_at || null,
    updated_at: row.updated_at,
  };
}

function normalizeAnswer(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A short answer may list accepted spellings separated by "|".
function isCorrect(question, answer) {
  const given = normalizeAnswer(answer);
  if (!given) return false;
  if (question.type === 'short_answer') {
    return String(question.answer).split('|').map(normalizeAnswer).filter(Boolean).includes(given);
  }
  return given === normalizeAnswer(question.answer);
}

module.exports = function trainingRoutes(db) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((error) => {
    console.error('[training]', error);
    res.status(500).json({ error: error.message || 'Training request failed' });
  });

  router.use(async (req, res, next) => {
    try {
      const user = await db.prepare(
        'SELECT id, username, full_name, role, is_super_admin FROM users WHERE id = ? AND is_active = 1'
      ).get(req.user?.id);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.currentUser = user;
      return next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  function requireManager(req, res, next) {
    if (!isManager(req.currentUser)) return res.status(403).json({ error: 'HR access required' });
    return next();
  }

  async function loadTraining(id) {
    const row = await db.prepare('SELECT * FROM trainings WHERE id = ?').get(Number(id));
    return row || null;
  }

  async function loadProgress(userId, trainingId) {
    return db.prepare('SELECT * FROM training_progress WHERE user_id = ? AND training_id = ?').get(Number(userId), Number(trainingId));
  }

  async function ensureProgress(userId, trainingId) {
    const existing = await loadProgress(userId, trainingId);
    if (existing) return existing;
    await db.prepare(
      "INSERT INTO training_progress (user_id, training_id, status, lessons_done) VALUES (?, ?, 'in_progress', '[]')"
    ).run(Number(userId), Number(trainingId));
    return loadProgress(userId, trainingId);
  }

  async function issueCertificate(user, training, score) {
    const existing = await db.prepare(
      'SELECT * FROM training_certificates WHERE user_id = ? AND training_id = ?'
    ).get(Number(user.id), Number(training.id));
    if (existing) {
      if (score !== null && (existing.score === null || Number(score) > Number(existing.score))) {
        await db.prepare('UPDATE training_certificates SET score = ? WHERE id = ?').run(score, existing.id);
      }
      return existing.code;
    }
    const code = `YNT-${manilaToday().slice(0, 4)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await db.prepare(
      'INSERT INTO training_certificates (user_id, training_id, code, score, training_title) VALUES (?, ?, ?, ?, ?)'
    ).run(Number(user.id), Number(training.id), code, score, training.title);
    return code;
  }

  // A learner may open a published training; an author may open any.
  async function readableTraining(req, res) {
    const row = await loadTraining(req.params.id);
    if (!row || (row.status !== 'published' && !isManager(req.currentUser))) {
      res.status(404).json({ error: 'Training not found' });
      return null;
    }
    return row;
  }

  router.get('/categories', wrap(async (req, res) => {
    const rows = await db.prepare('SELECT id, name, sort_order FROM training_categories ORDER BY sort_order ASC, name ASC').all();
    res.json({ categories: rows });
  }));

  // Everything the learner pages need in one call: every published training
  // (the library), whether it is assigned to me, and my progress on each.
  router.get('/me', wrap(async (req, res) => {
    const user = req.currentUser;
    const rows = await db.prepare("SELECT * FROM trainings WHERE status = 'published' ORDER BY created_at DESC, id DESC").all();
    const progress = await db.prepare('SELECT * FROM training_progress WHERE user_id = ?').all(Number(user.id));
    const certificates = await db.prepare(
      'SELECT * FROM training_certificates WHERE user_id = ? ORDER BY issued_at DESC'
    ).all(Number(user.id));
    const byTraining = new Map(progress.map((row) => [Number(row.training_id), row]));
    const today = manilaToday();
    const trainings = rows.map((row) => {
      const training = shapeTraining(row);
      const mine = shapeProgress(byTraining.get(training.id));
      const assigned = inAudience(training, user);
      return {
        ...training,
        assigned,
        progress: mine,
        overdue: assigned && !!training.due_date && training.due_date < today && mine?.status !== 'completed',
      };
    });
    res.json({
      user: { id: Number(user.id), name: user.full_name || user.username, department: departmentOf(user) },
      trainings,
      certificates: certificates.map((row) => ({ ...row, id: Number(row.id), training_id: Number(row.training_id) })),
    });
  }));

  // Opening a training starts it.
  router.get('/trainings/:id', wrap(async (req, res) => {
    const row = await readableTraining(req, res);
    if (!row) return;
    const progress = row.status === 'published' ? await ensureProgress(req.currentUser.id, row.id) : await loadProgress(req.currentUser.id, row.id);
    res.json({ training: shapeTraining(row), progress: shapeProgress(progress) });
  }));

  router.post('/trainings/:id/lessons/:lessonId', wrap(async (req, res) => {
    const row = await readableTraining(req, res);
    if (!row) return;
    const training = shapeTraining(row);
    if (!training.lessons.some((lesson) => lesson.id === req.params.lessonId)) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    const progress = await ensureProgress(req.currentUser.id, row.id);
    const done = new Set(parse(progress.lessons_done, []));
    if (req.body?.done === false) done.delete(req.params.lessonId);
    else done.add(req.params.lessonId);
    const lessonsDone = training.lessons.map((lesson) => lesson.id).filter((lessonId) => done.has(lessonId));
    let { status } = progress;
    let completedAt = progress.completed_at || null;
    // With no quiz, finishing every lesson is finishing the training.
    if (!training.quiz.length && status !== 'completed' && lessonsDone.length === training.lessons.length) {
      status = 'completed';
      completedAt = new Date().toISOString();
      await issueCertificate(req.currentUser, training, null);
    }
    await db.prepare(`
      UPDATE training_progress SET lessons_done = ?, status = ?, completed_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(lessonsDone), status, completedAt, progress.id);
    res.json({ progress: shapeProgress(await loadProgress(req.currentUser.id, row.id)) });
  }));

  router.put('/trainings/:id/notes', wrap(async (req, res) => {
    const row = await readableTraining(req, res);
    if (!row) return;
    const progress = await ensureProgress(req.currentUser.id, row.id);
    await db.prepare("UPDATE training_progress SET notes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(text(req.body?.notes, 20000), progress.id);
    res.json({ ok: true });
  }));

  router.post('/trainings/:id/quiz', wrap(async (req, res) => {
    const row = await readableTraining(req, res);
    if (!row) return;
    const training = shapeTraining(row, { withKey: true });
    if (!training.quiz.length) return res.status(400).json({ error: 'This training has no quiz' });
    const progress = await ensureProgress(req.currentUser.id, row.id);
    const lessonsDone = parse(progress.lessons_done, []);
    // The quiz opens once every lesson is done — studying first is the point.
    if (training.lessons.some((lesson) => !lessonsDone.includes(lesson.id))) {
      return res.status(400).json({ error: 'Finish every lesson before taking the quiz' });
    }
    const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    let earned = 0;
    let total = 0;
    const results = training.quiz.map((question) => {
      const points = Number(question.points || 1);
      const correct = isCorrect(question, answers[question.id]);
      total += points;
      if (correct) earned += points;
      return { id: question.id, correct, answer: text(answers[question.id], 300) };
    });
    const score = total ? Math.round((earned / total) * 1000) / 10 : 0;
    const passed = score >= training.passing_score;
    const best = Math.max(score, progress.best_score === null || progress.best_score === undefined ? 0 : Number(progress.best_score));
    // A pass stays a pass: retaking a finished training can raise the best
    // score but never takes the completion away.
    const status = passed || progress.status === 'completed' ? 'completed' : 'failed';
    const completedAt = progress.completed_at || (passed ? new Date().toISOString() : null);
    const result = { score, passed, earned, total, results, at: new Date().toISOString() };
    await db.prepare(`
      UPDATE training_progress
      SET attempts = attempts + 1, last_score = ?, best_score = ?, last_result = ?, status = ?, completed_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(score, best, JSON.stringify(result), status, completedAt, progress.id);
    const certificate = passed ? await issueCertificate(req.currentUser, training, score) : null;
    res.json({ result, certificate, progress: shapeProgress(await loadProgress(req.currentUser.id, row.id)) });
  }));

  router.get('/certificates/:code', wrap(async (req, res) => {
    const cert = await db.prepare(`
      SELECT c.*, u.full_name, u.username, u.role
      FROM training_certificates c JOIN users u ON u.id = c.user_id
      WHERE c.code = ?
    `).get(String(req.params.code || ''));
    if (!cert || (Number(cert.user_id) !== Number(req.currentUser.id) && !isManager(req.currentUser))) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    res.json({
      certificate: {
        code: cert.code,
        score: cert.score === null ? null : Number(cert.score),
        training_title: cert.training_title,
        issued_at: cert.issued_at,
        name: cert.full_name || cert.username,
        department: departmentOf(cert),
      },
    });
  }));

  // Ranked by trainings completed, then average best quiz score.
  router.get('/leaderboard', wrap(async (req, res) => {
    const users = await db.prepare(
      'SELECT id, username, full_name, role FROM users WHERE is_active = 1 AND COALESCE(is_super_admin, 0) = 0'
    ).all();
    const rows = await db.prepare(`
      SELECT p.user_id, p.status, p.best_score
      FROM training_progress p JOIN trainings t ON t.id = p.training_id
      WHERE t.status = 'published'
    `).all();
    const certs = await db.prepare('SELECT user_id, COUNT(*) AS n FROM training_certificates GROUP BY user_id').all();
    const certBy = new Map(certs.map((row) => [Number(row.user_id), Number(row.n)]));
    const board = users.map((user) => {
      const mine = rows.filter((row) => Number(row.user_id) === Number(user.id));
      const completed = mine.filter((row) => row.status === 'completed');
      const scored = completed.filter((row) => row.best_score !== null && row.best_score !== undefined);
      return {
        id: Number(user.id),
        name: user.full_name || user.username,
        department: departmentOf(user),
        completed: completed.length,
        in_progress: mine.filter((row) => row.status !== 'completed').length,
        avg_score: scored.length ? Math.round((scored.reduce((sum, row) => sum + Number(row.best_score), 0) / scored.length) * 10) / 10 : null,
        certificates: certBy.get(Number(user.id)) || 0,
      };
    }).sort((a, b) => b.completed - a.completed || (b.avg_score ?? -1) - (a.avg_score ?? -1) || a.name.localeCompare(b.name));
    res.json({ leaderboard: board });
  }));

  // ─── Authoring (HR, Operation, super admin) ───────────────
  router.get('/admin/trainings', requireManager, wrap(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM trainings ORDER BY created_at DESC, id DESC').all();
    res.json({ trainings: rows.map((row) => shapeTraining(row, { withKey: true })) });
  }));

  router.post('/admin/trainings', requireManager, wrap(async (req, res) => {
    const values = cleanTraining(req.body || {});
    if (!values.title) return res.status(400).json({ error: 'Missing title' });
    const columns = Object.keys(values);
    const result = await db.prepare(`
      INSERT INTO trainings (${columns.join(', ')}, created_by) VALUES (${columns.map(() => '?').join(', ')}, ?)
    `).run(...columns.map((column) => values[column]), req.currentUser.id);
    res.status(201).json({ training: shapeTraining(await loadTraining(result.lastInsertRowid), { withKey: true }) });
  }));

  router.put('/admin/trainings/:id', requireManager, wrap(async (req, res) => {
    const existing = await loadTraining(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Training not found' });
    const values = cleanTraining({ ...shapeTraining(existing, { withKey: true }), ...(req.body || {}) });
    if (!values.title) return res.status(400).json({ error: 'Missing title' });
    const columns = Object.keys(values);
    await db.prepare(`
      UPDATE trainings SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?
    `).run(...columns.map((column) => values[column]), existing.id);
    res.json({ training: shapeTraining(await loadTraining(existing.id), { withKey: true }) });
  }));

  // Certificates already earned are kept: they were earned.
  router.delete('/admin/trainings/:id', requireManager, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await db.prepare('DELETE FROM training_progress WHERE training_id = ?').run(id);
    await db.prepare('DELETE FROM trainings WHERE id = ?').run(id);
    res.json({ ok: true });
  }));

  router.post('/admin/categories', requireManager, wrap(async (req, res) => {
    const name = text(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const dup = await db.prepare('SELECT id FROM training_categories WHERE LOWER(name) = LOWER(?)').get(name);
    if (dup) return res.status(409).json({ error: 'That category already exists' });
    const max = await db.prepare('SELECT MAX(sort_order) AS m FROM training_categories').get();
    await db.prepare('INSERT INTO training_categories (name, sort_order) VALUES (?, ?)').run(name, Number(max?.m || 0) + 1);
    res.status(201).json({ ok: true });
  }));

  // Trainings keep the category by name, so a rename carries them with it.
  router.put('/admin/categories/:id', requireManager, wrap(async (req, res) => {
    const row = await db.prepare('SELECT * FROM training_categories WHERE id = ?').get(Number(req.params.id));
    const name = text(req.body?.name, 80);
    if (!row) return res.status(404).json({ error: 'Category not found' });
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const dup = await db.prepare('SELECT id FROM training_categories WHERE LOWER(name) = LOWER(?) AND id <> ?').get(name, row.id);
    if (dup) return res.status(409).json({ error: 'That category already exists' });
    await db.prepare('UPDATE training_categories SET name = ? WHERE id = ?').run(name, row.id);
    await db.prepare('UPDATE trainings SET category = ? WHERE category = ?').run(name, row.name);
    res.json({ ok: true });
  }));

  router.delete('/admin/categories/:id', requireManager, wrap(async (req, res) => {
    const row = await db.prepare('SELECT * FROM training_categories WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Category not found' });
    const used = await db.prepare('SELECT COUNT(*) AS n FROM trainings WHERE category = ?').get(row.name);
    if (Number(used?.n)) return res.status(409).json({ error: `${used.n} training(s) still use this category. Move them first.` });
    await db.prepare('DELETE FROM training_categories WHERE id = ?').run(row.id);
    res.json({ ok: true });
  }));

  // Everything the Training Reports page builds its matrix from.
  router.get('/admin/report', requireManager, wrap(async (req, res) => {
    const users = await db.prepare(
      'SELECT id, username, full_name, role FROM users WHERE is_active = 1 AND COALESCE(is_super_admin, 0) = 0 ORDER BY full_name COLLATE NOCASE ASC'
    ).all();
    const trainings = (await db.prepare("SELECT * FROM trainings WHERE status = 'published' ORDER BY created_at DESC, id DESC").all())
      .map((row) => shapeTraining(row));
    const progress = await db.prepare('SELECT * FROM training_progress').all();
    const today = manilaToday();
    res.json({
      today,
      users: users.map((user) => ({ id: Number(user.id), name: user.full_name || user.username, role: user.role, department: departmentOf(user) })),
      trainings: trainings.map((training) => ({
        ...training,
        assigned_user_ids: users.filter((user) => inAudience(training, user)).map((user) => Number(user.id)),
      })),
      progress: progress.map((row) => ({ user_id: Number(row.user_id), training_id: Number(row.training_id), ...shapeProgress(row) })),
    });
  }));

  router.delete('/admin/progress/:trainingId/:userId', requireManager, wrap(async (req, res) => {
    await db.prepare('DELETE FROM training_progress WHERE training_id = ? AND user_id = ?')
      .run(Number(req.params.trainingId), Number(req.params.userId));
    res.json({ ok: true });
  }));

  return router;
};

module.exports.departmentOf = departmentOf;
module.exports.isCorrect = isCorrect;
