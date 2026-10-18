// Training Center routes. Run: node --experimental-sqlite --test backend/tests/
// Uses an in-memory SQLite database with the real schema.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.DATABASE_URL;

const { SqliteClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');
const trainingRoutes = require('../routes/training');

async function startApp() {
  const db = new SqliteClient(':memory:');
  await initializeDatabaseAsync(db);
  const insert = db.prepare("INSERT INTO users (username, password, full_name, role) VALUES (?, 'x', ?, ?)");
  const ids = {
    hr: Number(insert.run('hr1', 'HR Person', 'HR').lastInsertRowid),
    csr: Number(insert.run('csr1', 'CSR Person', 'CSR').lastInsertRowid),
    rmo: Number(insert.run('rmo1', 'RMO Person', 'RMO').lastInsertRowid),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ids[req.headers['x-test-user'] || 'hr'] };
    next();
  });
  app.use('/api/training', trainingRoutes(db));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/training`;
  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': as } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { db, ids, server, call };
}

const sample = {
  title: 'Order Confirmation Basics',
  category: 'CSR Management',
  status: 'published',
  passing_score: 70,
  audience: { departments: ['CSR'] },
  due_date: '2000-01-01',
  lessons: [{ title: 'Intro', url: 'https://drive.google.com/file/d/abc/view', minutes: 5 }, { title: 'Scripts', url: 'https://youtu.be/xyz', minutes: 10 }],
  quiz: [
    { type: 'multiple_choice', question: 'Confirm by?', options: ['Call', 'Email'], answer: 'Call', points: 1 },
    { type: 'true_false', question: 'Upsell every order?', answer: 'True', points: 1 },
    { type: 'short_answer', question: 'POS name?', answer: 'Pancake|Pancake POS', points: 2 },
  ],
};

test('only HR, Operation and the super admin author trainings', async () => {
  const { server, call } = await startApp();
  try {
    assert.equal((await call('POST', '/admin/trainings', { as: 'csr', body: sample })).status, 403);
    assert.equal((await call('GET', '/admin/report', { as: 'csr' })).status, 403);
    assert.equal((await call('POST', '/admin/trainings', { as: 'hr', body: sample })).status, 201);
    assert.equal((await call('GET', '/categories', { as: 'csr' })).data.categories.length > 0, true);
  } finally {
    server.close();
  }
});

test('learners never receive answer keys; assignment follows the department', async () => {
  const { server, call } = await startApp();
  try {
    const created = await call('POST', '/admin/trainings', { body: sample });
    assert.equal(created.data.training.quiz[0].answer, 'Call');
    const id = created.data.training.id;

    const csr = await call('GET', '/me', { as: 'csr' });
    const mine = csr.data.trainings.find((t) => t.id === id);
    assert.equal(mine.assigned, true);
    assert.equal(mine.overdue, true);
    assert.ok(mine.quiz.every((q) => !('answer' in q)));

    const rmo = await call('GET', '/me', { as: 'rmo' });
    assert.equal(rmo.data.trainings.find((t) => t.id === id).assigned, false);

    const detail = await call('GET', `/trainings/${id}`, { as: 'csr' });
    assert.ok(detail.data.training.quiz.every((q) => !('answer' in q)));
    assert.equal(detail.data.progress.status, 'in_progress');

    // Drafts are invisible to learners.
    const draft = await call('POST', '/admin/trainings', { body: { ...sample, status: 'draft' } });
    assert.equal((await call('GET', `/trainings/${draft.data.training.id}`, { as: 'csr' })).status, 404);
  } finally {
    server.close();
  }
});

test('quiz is gated on lessons, scored on the server, and a pass issues one certificate', async () => {
  const { server, call } = await startApp();
  try {
    const { training } = (await call('POST', '/admin/trainings', { body: sample })).data;
    const [q1, q2, q3] = training.quiz;
    const answers = { [q1.id]: 'Call', [q2.id]: 'False', [q3.id]: ' pancake pos ' };

    const early = await call('POST', `/trainings/${training.id}/quiz`, { as: 'csr', body: { answers } });
    assert.equal(early.status, 400);

    for (const lesson of training.lessons) {
      await call('POST', `/trainings/${training.id}/lessons/${lesson.id}`, { as: 'csr', body: { done: true } });
    }

    // 3 of 4 points = 75% against a 70% pass mark.
    const pass = await call('POST', `/trainings/${training.id}/quiz`, { as: 'csr', body: { answers } });
    assert.equal(pass.data.result.score, 75);
    assert.equal(pass.data.result.passed, true);
    assert.equal(pass.data.progress.status, 'completed');
    assert.ok(pass.data.certificate);
    // The result says what was wrong, never what was right.
    assert.ok(pass.data.result.results.every((r) => !('expected' in r)));
    assert.equal(pass.data.result.results.find((r) => r.id === q2.id).correct, false);

    // A worse retake keeps the completion and the best score.
    const retake = await call('POST', `/trainings/${training.id}/quiz`, { as: 'csr', body: { answers: {} } });
    assert.equal(retake.data.progress.status, 'completed');
    assert.equal(retake.data.progress.best_score, 75);
    assert.equal(retake.data.progress.attempts, 2);

    const me = await call('GET', '/me', { as: 'csr' });
    assert.equal(me.data.certificates.length, 1);
    const cert = await call('GET', `/certificates/${pass.data.certificate}`, { as: 'csr' });
    assert.equal(cert.data.certificate.name, 'CSR Person');
    assert.equal((await call('GET', `/certificates/${pass.data.certificate}`, { as: 'rmo' })).status, 404);

    const board = await call('GET', '/leaderboard', { as: 'rmo' });
    assert.equal(board.data.leaderboard[0].name, 'CSR Person');
  } finally {
    server.close();
  }
});

test('a training without a quiz completes when every lesson is done; categories rename and guard', async () => {
  const { server, call, db } = await startApp();
  try {
    const { training } = (await call('POST', '/admin/trainings', { body: { ...sample, quiz: [], category: 'Leadership' } })).data;
    const [first, second] = training.lessons;
    await call('POST', `/trainings/${training.id}/lessons/${first.id}`, { as: 'rmo' });
    const done = await call('POST', `/trainings/${training.id}/lessons/${second.id}`, { as: 'rmo' });
    assert.equal(done.data.progress.status, 'completed');

    const cat = await db.prepare("SELECT id FROM training_categories WHERE name = 'Leadership'").get();
    assert.equal((await call('DELETE', `/admin/categories/${cat.id}`)).status, 409);
    await call('PUT', `/admin/categories/${cat.id}`, { body: { name: 'Team Leadership' } });
    const after = await call('GET', '/admin/trainings');
    assert.equal(after.data.trainings[0].category, 'Team Leadership');
  } finally {
    server.close();
  }
});
