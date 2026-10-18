/* ═══════════════════════════════════════════════════════════
   TRAINING CENTER — My Training, Leaderboard, Manage Trainings, Training Reports
   Backed by /api/training. Every account learns; HR, Operation and the super
   admin also author trainings and read the reports.
   Loaded before app.js; it leans on app.js globals (escapeHtml,
   authorizedJsonRequest, showToast, openModal, closeModal, manilaToday,
   DEPARTMENT_ORDER, canManageHR) read at call time.
   ═══════════════════════════════════════════════════════════ */

const TR_STATUS = {
  not_started: { label: 'Not Started', tone: 'gray' },
  in_progress: { label: 'In Progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed — retry', tone: 'danger' },
};

const trState = {
  tab: 'assigned',
  data: null,
  openId: null,
  detail: null,
  lessonIndex: 0,
  quizResult: null,
  search: '',
  category: '',
};

function trApi(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  return authorizedJsonRequest(`/training${path}`, init);
}

function trStatusOf(training) {
  return training.progress?.status || 'not_started';
}

function trBadge(status, overdue = false) {
  const info = TR_STATUS[status] || TR_STATUS.not_started;
  return `<span class="badge badge-${info.tone}">${escapeHtml(info.label)}</span>${overdue ? ' <span class="badge badge-danger">Overdue</span>' : ''}`;
}

function trPercent(training) {
  const lessons = training.lessons?.length || 0;
  const done = training.progress?.lessons_done?.length || 0;
  if (trStatusOf(training) === 'completed') return 100;
  const steps = lessons + (training.quiz?.length ? 1 : 0);
  return steps ? Math.round((done / steps) * 100) : 0;
}

function trMinutes(minutes) {
  const value = Number(minutes || 0);
  if (!value) return '';
  return value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}` : `${value} min`;
}

function trDate(value) {
  if (!value) return '';
  const parsed = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Google Drive, Docs/Slides and YouTube links play inside the page; anything
// else opens in a new tab.
function trEmbedUrl(url) {
  const raw = String(url || '').trim();
  let match = raw.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || raw.match(/drive\.google\.com\/open\?id=([\w-]+)/);
  if (match) return `https://drive.google.com/file/d/${match[1]}/preview`;
  match = raw.match(/docs\.google\.com\/presentation\/d\/([\w-]+)/);
  if (match) return `https://docs.google.com/presentation/d/${match[1]}/embed`;
  match = raw.match(/docs\.google\.com\/(document|spreadsheets)\/d\/([\w-]+)/);
  if (match) return `https://docs.google.com/${match[1]}/d/${match[2]}/preview`;
  match = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/);
  if (match) return `https://www.youtube.com/embed/${match[1]}`;
  return null;
}

function trSafeUrl(url) {
  const raw = String(url || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

// ─── MY TRAINING ───────────────────────────────────────────
function renderTrainingPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>My Training</h1>
      <p>Your assigned trainings, the full library, and the certificates you have earned.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="initTrainingPage()">Refresh</button>
    </div>
  </div>
  <div id="tr-root"><div class="card"><div class="empty-state"><h3>Loading trainings</h3></div></div></div>`;
}

async function initTrainingPage() {
  try {
    trState.data = await trApi('/me');
  } catch (error) {
    const root = document.getElementById('tr-root');
    if (root) root.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load trainings</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  if (trState.openId) await openTraining(trState.openId);
  else renderTrainingBody();
}

function renderTrainingBody() {
  const root = document.getElementById('tr-root');
  if (!root || !trState.data) return;
  if (trState.openId && trState.detail) { root.innerHTML = renderTrainingDetail(); return; }
  const all = trState.data.trainings || [];
  const assigned = all.filter((t) => t.assigned);
  const done = assigned.filter((t) => trStatusOf(t) === 'completed');
  const overdue = assigned.filter((t) => t.overdue);
  const inProgress = all.filter((t) => ['in_progress', 'failed'].includes(trStatusOf(t)));
  const certs = trState.data.certificates || [];
  const stat = (tone, label, value, meta) => `<div class="stat-card ${tone}"><div class="stat-card-accent"></div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-meta">${escapeHtml(meta)}</div></div>`;
  let body = '';
  if (trState.tab === 'library') body = renderTrainingLibrary(all);
  else if (trState.tab === 'certificates') body = renderTrainingCertificates(certs);
  else body = renderTrainingAssigned(assigned, inProgress);
  root.innerHTML = `
    <div class="stats-grid">
      ${stat('blue', 'Assigned to me', assigned.length, `${trState.data.user?.department || ''} trainings`)}
      ${stat('green', 'Completed', done.length, assigned.length ? `${Math.round((done.length / assigned.length) * 100)}% of assigned` : 'nothing assigned yet')}
      ${stat('amber', 'In Progress', inProgress.length, 'started, not finished')}
      ${stat('red', 'Overdue', overdue.length, overdue.length ? 'past the due date' : 'all on time')}
    </div>
    <div class="tabs">
      ${[['assigned', 'Assigned to me'], ['library', `Library (${all.length})`], ['certificates', `Certificates (${certs.length})`]].map(([id, label]) =>
        `<button class="tab-btn${trState.tab === id ? ' active' : ''}" onclick="trState.tab='${id}'; renderTrainingBody()">${label}</button>`).join('')}
    </div>
    ${body}`;
}

function renderTrainingCard(training) {
  const status = trStatusOf(training);
  const percent = trPercent(training);
  const meta = [
    training.lessons.length ? `${training.lessons.length} lesson${training.lessons.length === 1 ? '' : 's'}` : '',
    training.quiz.length ? `${training.quiz.length}-question quiz` : '',
    trMinutes(training.estimated_minutes),
  ].filter(Boolean).join(' · ');
  return `
  <button type="button" class="tr-card" onclick="openTraining(${Number(training.id)})">
    <span class="tr-card-top">
      <span class="badge badge-gray">${escapeHtml(training.category || 'General')}</span>
      ${training.required && training.assigned ? '<span class="badge badge-warning">Required</span>' : ''}
    </span>
    <span class="tr-card-title">${escapeHtml(training.title)}</span>
    ${training.description ? `<span class="tr-card-desc">${escapeHtml(training.description)}</span>` : ''}
    <span class="tr-card-meta">${escapeHtml(meta)}</span>
    <span class="tr-bar"><span style="width:${percent}%;"></span></span>
    <span class="tr-card-foot">
      ${trBadge(status, training.overdue)}
      <span class="text-xs text-muted">${training.due_date && training.assigned ? `Due ${escapeHtml(trDate(training.due_date))}` : `${percent}%`}</span>
    </span>
  </button>`;
}

function renderTrainingAssigned(assigned, inProgress) {
  if (!assigned.length && !inProgress.length) {
    return '<div class="card"><div class="empty-state"><h3>Nothing assigned to you yet</h3><p>Browse the Library tab — anything there is open to you.</p></div></div>';
  }
  // Overdue first, then what is due soonest, then the rest; finished last.
  const rank = (t) => (trStatusOf(t) === 'completed' ? 3 : t.overdue ? 0 : t.due_date ? 1 : 2);
  const ordered = [...assigned].sort((a, b) => rank(a) - rank(b) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const extra = inProgress.filter((t) => !t.assigned);
  return `
    <div class="tr-grid">${ordered.map(renderTrainingCard).join('')}</div>
    ${extra.length ? `<div class="card-subtitle" style="margin:22px 0 10px;font-weight:600;">Also started from the library</div><div class="tr-grid">${extra.map(renderTrainingCard).join('')}</div>` : ''}`;
}

function renderTrainingLibrary(all) {
  const query = trState.search.trim().toLowerCase();
  const filtered = all.filter((t) => (!trState.category || t.category === trState.category)
    && (!query || `${t.title} ${t.description} ${t.category}`.toLowerCase().includes(query)));
  const categories = [...new Set(all.map((t) => t.category || 'General'))].sort();
  const groups = new Map();
  filtered.forEach((t) => {
    const key = t.category || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  return `
    <div class="tr-toolbar">
      <input type="search" class="form-control" style="max-width:280px;" placeholder="Search trainings" value="${escapeHtml(trState.search)}" oninput="trState.search=this.value; trRefreshLibrary()">
      <span class="tr-pills">
        <button class="filter-pill${!trState.category ? ' active' : ''}" onclick="trState.category=''; renderTrainingBody()">All</button>
        ${categories.map((c) => `<button class="filter-pill${trState.category === c ? ' active' : ''}" onclick="trState.category=${escapeHtml(JSON.stringify(c))}; renderTrainingBody()">${escapeHtml(c)}</button>`).join('')}
      </span>
    </div>
    <div id="tr-library-list">
      ${filtered.length ? [...groups.entries()].map(([category, list]) => `
        <div class="tr-group-head">${escapeHtml(category)} <span class="text-muted">· ${list.length}</span></div>
        <div class="tr-grid">${list.map(renderTrainingCard).join('')}</div>`).join('')
        : '<div class="card"><div class="empty-state"><h3>No trainings found</h3><p>Try another search or category.</p></div></div>'}
    </div>`;
}

// Re-render only the list so the search box keeps focus while typing.
function trRefreshLibrary() {
  const wrap = document.getElementById('tr-library-list');
  if (!wrap) return;
  const holder = document.createElement('div');
  holder.innerHTML = renderTrainingLibrary(trState.data?.trainings || []);
  wrap.innerHTML = holder.querySelector('#tr-library-list').innerHTML;
}

function renderTrainingCertificates(certs) {
  if (!certs.length) return '<div class="card"><div class="empty-state"><h3>No certificates yet</h3><p>Finish a training — and pass its quiz — to earn one.</p></div></div>';
  return `
  <div class="tr-grid">${certs.map((cert) => `
    <div class="tr-cert">
      <span class="tr-cert-seal">★</span>
      <span class="tr-card-title">${escapeHtml(cert.training_title || 'Training')}</span>
      <span class="tr-card-meta">Issued ${escapeHtml(trDate(cert.issued_at))}${cert.score !== null && cert.score !== undefined ? ` · Score ${Number(cert.score)}%` : ''}</span>
      <span class="text-xs text-muted">${escapeHtml(cert.code)}</span>
      <button class="btn btn-secondary btn-sm" style="margin-top:8px;align-self:flex-start;" onclick="printTrainingCertificate('${escapeHtml(cert.code)}')">View / Print</button>
    </div>`).join('')}</div>`;
}

// ─── TRAINING DETAIL ───────────────────────────────────────
async function openTraining(id) {
  try {
    const result = await trApi(`/trainings/${Number(id)}`);
    trState.openId = Number(id);
    trState.detail = result;
    trState.quizResult = result.progress?.last_result && result.progress.status !== 'completed' ? result.progress.last_result : null;
    // Land on the first lesson not yet done.
    const done = result.progress?.lessons_done || [];
    const next = result.training.lessons.findIndex((lesson) => !done.includes(lesson.id));
    trState.lessonIndex = next === -1 ? 0 : next;
    if (App.currentPage !== 'learning') { navigateTo('learning'); return; }
    renderTrainingBody();
    document.getElementById('main-page-content')?.scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  } catch (error) {
    showToast('error', 'Could not open training', error.message || 'Please try again.');
  }
}

function closeTraining() {
  trState.openId = null;
  trState.detail = null;
  trState.quizResult = null;
  initTrainingPage();
}

function renderTrainingDetail() {
  const { training, progress } = trState.detail;
  const done = progress?.lessons_done || [];
  const lessons = training.lessons;
  const lesson = lessons[trState.lessonIndex];
  const allLessonsDone = lessons.every((l) => done.includes(l.id));
  const status = progress?.status || 'not_started';
  const fromList = (trState.data?.trainings || []).find((t) => t.id === training.id);
  const percent = trPercent({ ...training, progress });
  const embed = lesson ? trEmbedUrl(lesson.url) : null;
  const lessonUrl = lesson ? trSafeUrl(lesson.url) : '';
  return `
  <div class="tr-detail-head">
    <button class="btn btn-secondary btn-sm" onclick="closeTraining()">← Back</button>
    <div style="flex:1;min-width:0;">
      <div class="tr-detail-title">${escapeHtml(training.title)}</div>
      <div class="text-xs text-muted">${escapeHtml(training.category || 'General')}${training.estimated_minutes ? ` · ${escapeHtml(trMinutes(training.estimated_minutes))}` : ''}${training.due_date && fromList?.assigned ? ` · Due ${escapeHtml(trDate(training.due_date))}` : ''}${training.quiz.length ? ` · Pass mark ${training.passing_score}%` : ''}</div>
    </div>
    ${trBadge(status, fromList?.overdue)}
  </div>
  <div class="tr-bar tr-bar-lg"><span style="width:${percent}%;"></span></div>

  <div class="tr-detail-layout">
    <div>
      ${lesson ? `
      <div class="card" style="margin-bottom:20px;">
        <div class="card-header">
          <div><div class="card-title">Lesson ${trState.lessonIndex + 1} of ${lessons.length} — ${escapeHtml(lesson.title)}</div>${lesson.minutes ? `<div class="card-subtitle">${escapeHtml(trMinutes(lesson.minutes))}</div>` : ''}</div>
          ${lessonUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(lessonUrl)}" target="_blank" rel="noopener">Open in new tab</a>` : ''}
        </div>
        <div class="card-body">
          ${embed ? `<div class="tr-player"><iframe src="${escapeHtml(embed)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen loading="lazy" title="${escapeHtml(lesson.title)}"></iframe></div>`
            : `<div class="empty-state"><p>This lesson opens outside the dashboard.</p>${lessonUrl ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(lessonUrl)}" target="_blank" rel="noopener">Open lesson</a>` : ''}</div>`}
          <div class="tr-lesson-actions">
            <button class="btn btn-secondary btn-sm" ${trState.lessonIndex === 0 ? 'disabled' : ''} onclick="trState.lessonIndex--; renderTrainingBody()">← Previous</button>
            ${done.includes(lesson.id)
              ? `<button class="btn btn-secondary btn-sm" onclick="setTrainingLesson('${escapeHtml(lesson.id)}', false)">✓ Done — undo</button>`
              : `<button class="btn btn-primary btn-sm" onclick="setTrainingLesson('${escapeHtml(lesson.id)}', true)">Mark lesson done</button>`}
            <button class="btn btn-secondary btn-sm" ${trState.lessonIndex >= lessons.length - 1 ? 'disabled' : ''} onclick="trState.lessonIndex++; renderTrainingBody()">Next →</button>
          </div>
        </div>
      </div>` : ''}
      ${training.quiz.length ? renderTrainingQuiz(training, progress, allLessonsDone) : ''}
      ${!training.quiz.length && status === 'completed' ? `<div class="card"><div class="card-body tr-complete">🎉 Training complete. <button class="btn btn-secondary btn-sm" onclick="trOpenCertFor(${training.id})">View certificate</button></div></div>` : ''}
    </div>

    <div>
      ${lessons.length ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><div><div class="card-title">Lessons</div><div class="card-subtitle">${done.length} of ${lessons.length} done</div></div></div>
        <div class="card-body tr-lesson-list">
          ${lessons.map((l, i) => `<button type="button" class="tr-lesson${i === trState.lessonIndex ? ' active' : ''}" onclick="trState.lessonIndex=${i}; renderTrainingBody()">
            <span class="tr-lesson-check${done.includes(l.id) ? ' done' : ''}">${done.includes(l.id) ? '✓' : i + 1}</span>
            <span>${escapeHtml(l.title)}${l.minutes ? `<span class="text-xs text-muted"> · ${escapeHtml(trMinutes(l.minutes))}</span>` : ''}</span>
          </button>`).join('')}
          ${training.quiz.length ? `<div class="tr-lesson${allLessonsDone ? '' : ' locked'}"><span class="tr-lesson-check${status === 'completed' ? ' done' : ''}">${status === 'completed' ? '✓' : '?'}</span><span>Quiz${allLessonsDone ? '' : ' — after the lessons'}</span></div>` : ''}
        </div>
      </div>` : ''}
      ${training.description || training.instructions ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><div class="card-title">About this training</div></div>
        <div class="card-body tr-prose">${training.description ? `<p>${escapeHtml(training.description)}</p>` : ''}${training.instructions ? `<p class="text-xs text-muted" style="margin-bottom:4px;">INSTRUCTIONS</p><p>${escapeHtml(training.instructions)}</p>` : ''}</div>
      </div>` : ''}
      ${training.materials.length ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><div class="card-title">Materials</div></div>
        <div class="card-body">${training.materials.map((m) => trSafeUrl(m.url) ? `<a class="tr-material" href="${escapeHtml(trSafeUrl(m.url))}" target="_blank" rel="noopener">📄 ${escapeHtml(m.name)}</a>` : '').join('')}</div>
      </div>` : ''}
      <div class="card">
        <div class="card-header"><div><div class="card-title">My notes</div><div class="card-subtitle">Private to you. Saved when you click away.</div></div></div>
        <div class="card-body"><textarea class="form-control" rows="5" placeholder="Write what you want to remember…" onchange="saveTrainingNotes(this.value)">${escapeHtml(progress?.notes || '')}</textarea></div>
      </div>
    </div>
  </div>`;
}

function renderTrainingQuiz(training, progress, allLessonsDone) {
  const status = progress?.status;
  const result = trState.quizResult;
  if (!allLessonsDone) {
    return `<div class="card"><div class="card-body"><div class="empty-state"><h3>🔒 Quiz</h3><p>Finish every lesson to unlock the ${training.quiz.length}-question quiz. Pass mark: ${training.passing_score}%.</p></div></div></div>`;
  }
  if (status === 'completed' && !trState.retaking) {
    return `<div class="card"><div class="card-body tr-complete">
      <div>🎉 Passed — best score <b>${Number(progress.best_score ?? progress.last_score ?? 0)}%</b> after ${progress.attempts} attempt${progress.attempts === 1 ? '' : 's'}.</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="trOpenCertFor(${training.id})">View certificate</button>
        <button class="btn btn-secondary btn-sm" onclick="trState.retaking=true; trState.quizResult=null; renderTrainingBody()">Retake quiz</button>
      </div>
    </div></div>`;
  }
  const verdict = result ? new Map(result.results.map((r) => [r.id, r])) : null;
  return `
  <div class="card">
    <div class="card-header"><div><div class="card-title">Quiz</div><div class="card-subtitle">${training.quiz.length} questions · pass mark ${training.passing_score}%${progress?.attempts ? ` · attempt ${progress.attempts + 1}` : ''}</div></div></div>
    <div class="card-body">
      ${result ? `<div class="tr-result ${result.passed ? 'pass' : 'fail'}">${result.passed ? '🎉 Passed' : 'Not yet'} — you scored <b>${result.score}%</b> (${result.earned}/${result.total} points). ${result.passed ? '' : 'The questions marked ✗ were wrong. Review the lessons and try again.'}</div>` : ''}
      <form id="tr-quiz-form" onsubmit="submitTrainingQuiz(event)">
        ${training.quiz.map((q, i) => {
          const mark = verdict?.get(q.id);
          const previous = mark?.answer || '';
          const choices = q.type === 'short_answer' ? null : q.options;
          return `<div class="tr-question${mark ? (mark.correct ? ' right' : ' wrong') : ''}">
            <div class="tr-q-text">${mark ? (mark.correct ? '✓ ' : '✗ ') : ''}${i + 1}. ${escapeHtml(q.question)} <span class="text-xs text-muted">(${q.points} pt${q.points === 1 ? '' : 's'})</span></div>
            ${choices ? choices.map((option) => `<label class="tr-option"><input type="radio" name="q_${escapeHtml(q.id)}" value="${escapeHtml(option)}"${previous === option ? ' checked' : ''} required> ${escapeHtml(option)}</label>`).join('')
              : `<input type="text" class="form-control" name="q_${escapeHtml(q.id)}" value="${escapeHtml(previous)}" placeholder="Your answer" required>`}
          </div>`;
        }).join('')}
        <button type="submit" class="btn btn-primary" id="tr-quiz-submit">${result ? 'Submit again' : 'Submit answers'}</button>
      </form>
    </div>
  </div>`;
}

async function setTrainingLesson(lessonId, done) {
  const { training } = trState.detail;
  try {
    const result = await trApi(`/trainings/${training.id}/lessons/${encodeURIComponent(lessonId)}`, { method: 'POST', body: { done } });
    const wasComplete = trState.detail.progress?.status === 'completed';
    trState.detail.progress = result.progress;
    // Move on to the next unfinished lesson.
    if (done) {
      const next = training.lessons.findIndex((l) => !result.progress.lessons_done.includes(l.id));
      if (next !== -1) trState.lessonIndex = next;
    }
    trSyncListProgress(result.progress);
    renderTrainingBody();
    if (!wasComplete && result.progress.status === 'completed') showToast('success', 'Training complete', 'Your certificate is ready.');
  } catch (error) {
    showToast('error', 'Could not save', error.message || 'Please try again.');
  }
}

async function saveTrainingNotes(value) {
  try {
    await trApi(`/trainings/${trState.detail.training.id}/notes`, { method: 'PUT', body: { notes: value } });
    trState.detail.progress = { ...(trState.detail.progress || {}), notes: value };
  } catch (error) {
    showToast('error', 'Notes not saved', error.message || 'Please try again.');
  }
}

async function submitTrainingQuiz(event) {
  event.preventDefault();
  const { training } = trState.detail;
  const form = document.getElementById('tr-quiz-form');
  const answers = {};
  training.quiz.forEach((q) => {
    const field = form.elements[`q_${q.id}`];
    answers[q.id] = field ? (field.value ?? '') : '';
  });
  const button = document.getElementById('tr-quiz-submit');
  if (button) button.disabled = true;
  try {
    const result = await trApi(`/trainings/${training.id}/quiz`, { method: 'POST', body: { answers } });
    trState.detail.progress = result.progress;
    trState.quizResult = result.result;
    trState.retaking = false;
    trSyncListProgress(result.progress);
    if (result.result.passed) {
      trState.quizResult = null;
      showToast('success', `Passed with ${result.result.score}%`, 'Your certificate is ready.');
    }
    renderTrainingBody();
  } catch (error) {
    if (button) button.disabled = false;
    showToast('error', 'Quiz not submitted', error.message || 'Please try again.');
  }
}

// Keep the list behind the detail view in step, so Back shows the new state.
function trSyncListProgress(progress) {
  const row = (trState.data?.trainings || []).find((t) => t.id === trState.openId);
  if (row) {
    row.progress = progress;
    if (progress.status === 'completed') row.overdue = false;
  }
}

async function trOpenCertFor(trainingId) {
  try {
    const me = await trApi('/me');
    trState.data = { ...trState.data, certificates: me.certificates };
    const cert = (me.certificates || []).find((c) => Number(c.training_id) === Number(trainingId));
    if (!cert) { showToast('info', 'No certificate yet', 'It appears once the training is completed.'); return; }
    printTrainingCertificate(cert.code);
  } catch (error) {
    showToast('error', 'Could not load certificate', error.message || 'Please try again.');
  }
}

// The certificate opens as its own printable page.
async function printTrainingCertificate(code) {
  const popup = window.open('', '_blank');
  if (!popup) { showToast('warning', 'Pop-up blocked', 'Allow pop-ups for this site to print the certificate.'); return; }
  try {
    const { certificate: c } = await trApi(`/certificates/${encodeURIComponent(code)}`);
    const esc = (v) => escapeHtml(String(v ?? ''));
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Certificate — ${esc(c.training_title)}</title>
      <style>
        @page { size: landscape; margin: 0; }
        body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: #f4f1ea; color: #1f2937; }
        .sheet { box-sizing: border-box; width: 1056px; height: 744px; margin: 24px auto; background: #fffdf8; padding: 56px 72px; border: 14px solid #0f2a44; outline: 3px solid #c9a227; outline-offset: -26px; text-align: center; position: relative; }
        .brand { font-family: system-ui, sans-serif; letter-spacing: 6px; font-size: 13px; color: #0f2a44; font-weight: 700; }
        h1 { font-size: 46px; margin: 34px 0 6px; color: #0f2a44; font-weight: 400; letter-spacing: 2px; }
        .sub { font-size: 16px; color: #6b7280; }
        .name { font-size: 40px; margin: 34px 0 6px; font-style: italic; color: #111827; border-bottom: 1px solid #c9a227; display: inline-block; padding: 0 30px 8px; }
        .dept { font-family: system-ui, sans-serif; font-size: 13px; color: #6b7280; letter-spacing: 2px; text-transform: uppercase; }
        .course { font-size: 26px; margin: 26px 0 4px; color: #0f2a44; }
        .meta { font-family: system-ui, sans-serif; font-size: 13px; color: #6b7280; margin-top: 8px; }
        .foot { position: absolute; left: 72px; right: 72px; bottom: 56px; display: flex; justify-content: space-between; font-family: system-ui, sans-serif; font-size: 12px; color: #6b7280; }
        .seal { position: absolute; right: 90px; top: 70px; width: 92px; height: 92px; border-radius: 50%; background: #c9a227; color: #fff; display: grid; place-items: center; font-size: 38px; box-shadow: 0 0 0 6px #fffdf8, 0 0 0 8px #c9a227; }
        @media print { body { background: #fff; } .sheet { margin: 0 auto; } .noprint { display: none; } }
        .noprint { text-align: center; margin: 16px; font-family: system-ui, sans-serif; }
        .noprint button { padding: 10px 18px; font-size: 14px; border-radius: 8px; border: 0; background: #0f2a44; color: #fff; cursor: pointer; }
      </style></head><body>
      <div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>
      <div class="sheet">
        <div class="seal">★</div>
        <div class="brand">YNT DIGITAL MARKETING · TRAINING CENTER</div>
        <h1>Certificate of Completion</h1>
        <div class="sub">This certifies that</div>
        <div class="name">${esc(c.name)}</div>
        <div class="dept">${esc(c.department)}</div>
        <div class="sub" style="margin-top:22px;">has successfully completed</div>
        <div class="course">${esc(c.training_title)}</div>
        ${c.score !== null && c.score !== undefined ? `<div class="meta">Final quiz score: ${esc(c.score)}%</div>` : ''}
        <div class="foot"><span>Issued ${esc(trDate(c.issued_at))}</span><span>Certificate no. ${esc(c.code)}</span></div>
      </div></body></html>`);
    popup.document.close();
  } catch (error) {
    popup.close();
    showToast('error', 'Could not load certificate', error.message || 'Please try again.');
  }
}

// ─── LEADERBOARD ───────────────────────────────────────────
const trBoardState = { rows: [], department: '' };

function renderTrainingLeaderboardPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Training Leaderboard</h1>
      <p>Ranked by trainings completed, then by average best quiz score.</p>
    </div>
  </div>
  <div class="card"><div class="card-body" id="tr-board-root"><div class="empty-state"><h3>Loading</h3></div></div></div>`;
}

async function initTrainingLeaderboardPage() {
  try {
    trBoardState.rows = (await trApi('/leaderboard')).leaderboard || [];
  } catch (error) {
    const root = document.getElementById('tr-board-root');
    if (root) root.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
    return;
  }
  renderTrainingLeaderboard();
}

function renderTrainingLeaderboard() {
  const root = document.getElementById('tr-board-root');
  if (!root) return;
  const departments = [...new Set(trBoardState.rows.map((r) => r.department))].sort();
  const rows = trBoardState.rows.filter((r) => !trBoardState.department || r.department === trBoardState.department);
  const medal = ['🥇', '🥈', '🥉'];
  root.innerHTML = `
    <div class="tr-pills" style="margin-bottom:14px;">
      <button class="filter-pill${!trBoardState.department ? ' active' : ''}" onclick="trBoardState.department=''; renderTrainingLeaderboard()">Everyone</button>
      ${departments.map((d) => `<button class="filter-pill${trBoardState.department === d ? ' active' : ''}" onclick="trBoardState.department=${escapeHtml(JSON.stringify(d))}; renderTrainingLeaderboard()">${escapeHtml(d)}</button>`).join('')}
    </div>
    <div class="table-container"><table>
      <thead><tr><th style="width:70px;">Rank</th><th>Employee</th><th>Department</th><th>Completed</th><th>In Progress</th><th>Avg Score</th><th>Certificates</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr${Number(r.id) === Number(App.user?.id) ? ' class="tr-me"' : ''}>
        <td><b>${r.completed ? (medal[i] || `#${i + 1}`) : '—'}</b></td>
        <td><strong>${escapeHtml(r.name)}</strong>${Number(r.id) === Number(App.user?.id) ? ' <span class="badge badge-info">You</span>' : ''}</td>
        <td>${escapeHtml(r.department)}</td>
        <td>${r.completed}</td>
        <td>${r.in_progress}</td>
        <td>${r.avg_score === null ? '—' : `${r.avg_score}%`}</td>
        <td>${r.certificates}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ─── MANAGE TRAININGS (HR) ─────────────────────────────────
const trAdminState = { trainings: [], categories: [], users: [], report: null, editor: null };

function renderTrainingManagePage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Manage Trainings</h1>
      <p>Build trainings from Drive / YouTube lessons, add a quiz, and assign them by department or person.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="openTrainingCategories()">Categories</button>
      <button class="btn btn-primary btn-sm" onclick="openTrainingEditor()">+ New Training</button>
    </div>
  </div>
  <div class="card"><div class="card-body" id="tr-admin-root"><div class="empty-state"><h3>Loading</h3></div></div></div>
  ${renderTrainingEditorModal()}
  ${renderTrainingCategoriesModal()}`;
}

async function initTrainingManagePage() {
  try {
    const [trainings, categories, users, report] = await Promise.all([
      trApi('/admin/trainings'),
      trApi('/categories'),
      authorizedJsonRequest('/orders/assignable-users'),
      trApi('/admin/report'),
    ]);
    trAdminState.trainings = trainings.trainings || [];
    trAdminState.categories = categories.categories || [];
    trAdminState.users = (users.users || []).filter((u) => !u.is_super_admin);
    trAdminState.report = report;
  } catch (error) {
    const root = document.getElementById('tr-admin-root');
    if (root) root.innerHTML = `<div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div>`;
    return;
  }
  renderTrainingAdminList();
}

function trAudienceLabel(audience) {
  if (!audience || audience.all) return 'Everyone';
  const parts = [...(audience.departments || [])];
  const people = (audience.user_ids || []).length;
  if (people) parts.push(`${people} person${people === 1 ? '' : 's'}`);
  return parts.join(', ') || 'Nobody yet';
}

function trCompletionFor(trainingId) {
  const report = trAdminState.report;
  const training = report?.trainings.find((t) => t.id === trainingId);
  if (!training) return null;
  const assigned = training.assigned_user_ids.length;
  const completed = report.progress.filter((p) => p.training_id === trainingId && p.status === 'completed'
    && training.assigned_user_ids.includes(p.user_id)).length;
  return { assigned, completed };
}

function renderTrainingAdminList() {
  const root = document.getElementById('tr-admin-root');
  if (!root) return;
  const rows = trAdminState.trainings;
  if (!rows.length) {
    root.innerHTML = '<div class="empty-state"><h3>No trainings yet</h3><p>Create the first one — paste Google Drive or YouTube links as lessons.</p></div>';
    return;
  }
  root.innerHTML = `
  <div class="table-container"><table>
    <thead><tr><th>Training</th><th>Category</th><th>Assigned To</th><th>Content</th><th>Due</th><th>Completion</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((t) => {
      const c = trCompletionFor(t.id);
      const pct = c && c.assigned ? Math.round((c.completed / c.assigned) * 100) : 0;
      return `<tr>
        <td><strong>${escapeHtml(t.title)}</strong>${t.required ? ' <span class="badge badge-warning">Required</span>' : ''}</td>
        <td>${escapeHtml(t.category || '—')}</td>
        <td class="text-xs">${escapeHtml(trAudienceLabel(t.audience))}</td>
        <td class="text-xs">${t.lessons.length} lesson${t.lessons.length === 1 ? '' : 's'} · ${t.quiz.length} Q · ${t.materials.length} file${t.materials.length === 1 ? '' : 's'}</td>
        <td>${t.due_date ? escapeHtml(trDate(t.due_date)) : '—'}</td>
        <td style="min-width:140px;">${c ? `<span class="tr-bar tr-bar-inline"><span style="width:${pct}%;"></span></span> <span class="text-xs">${c.completed}/${c.assigned}</span>` : '<span class="text-xs text-muted">Draft</span>'}</td>
        <td>${t.status === 'published' ? '<span class="badge badge-success">Published</span>' : '<span class="badge badge-gray">Draft</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="openTrainingEditor(${t.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="openTraining(${t.id})">Preview</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderTrainingEditorModal() {
  return `
  <div class="modal-overlay" id="tr-editor-modal">
    <div class="modal" style="max-width:860px;">
      <div class="modal-header">
        <div class="modal-title" id="tr-editor-title">New Training</div>
        <button class="modal-close" onclick="closeModal('tr-editor-modal')">&times;</button>
      </div>
      <div class="modal-body" id="tr-editor-body"></div>
    </div>
  </div>`;
}

function trBlankQuestion() {
  return { type: 'multiple_choice', question: '', options: ['', ''], answer: '', points: 1 };
}

function openTrainingEditor(id) {
  const existing = id ? trAdminState.trainings.find((t) => t.id === Number(id)) : null;
  trAdminState.editor = existing ? JSON.parse(JSON.stringify(existing)) : {
    title: '', description: '', category: trAdminState.categories[0]?.name || '', instructions: '',
    lessons: [{ title: '', url: '', minutes: '' }], materials: [], quiz: [], passing_score: 80,
    audience: { all: true }, required: false, due_date: '', status: 'draft',
  };
  document.getElementById('tr-editor-title').textContent = existing ? `Edit — ${existing.title}` : 'New Training';
  renderTrainingEditor();
  openModal('tr-editor-modal');
}

// The editor writes straight into trAdminState.editor; adding or removing a
// row re-renders the form from that state.
function trEd(path, value) {
  const keys = path.split('.');
  let target = trAdminState.editor;
  keys.slice(0, -1).forEach((key) => { target = target[key]; });
  target[keys[keys.length - 1]] = value;
}

function renderTrainingEditor() {
  const ed = trAdminState.editor;
  const body = document.getElementById('tr-editor-body');
  if (!ed || !body) return;
  const departments = (typeof DEPARTMENT_ORDER !== 'undefined' ? DEPARTMENT_ORDER : []).filter((d) => d !== 'Unassigned');
  const audience = ed.audience || { all: true };
  const val = (v) => escapeHtml(v ?? '');
  body.innerHTML = `
    <div class="tr-ed-section">
      <div class="form-group"><label class="form-label">Title</label><input class="form-control" value="${val(ed.title)}" oninput="trEd('title', this.value)" placeholder="e.g. Order Confirmation Basics"></div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Category</label><select class="form-control" onchange="trEd('category', this.value)">${trAdminState.categories.map((c) => `<option${c.name === ed.category ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Pass mark (%)</label><input type="number" min="1" max="100" class="form-control" value="${val(ed.passing_score)}" oninput="trEd('passing_score', this.value)"></div>
      </div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-control" rows="2" oninput="trEd('description', this.value)">${val(ed.description)}</textarea></div>
      <div class="form-group"><label class="form-label">Instructions</label><textarea class="form-control" rows="2" oninput="trEd('instructions', this.value)" placeholder="What to do, in what order">${val(ed.instructions)}</textarea></div>
    </div>

    <div class="tr-ed-section">
      <div class="tr-ed-head"><b>Lessons</b><span class="text-xs text-muted">Google Drive, Docs/Slides and YouTube links play inside the page.</span></div>
      ${ed.lessons.map((l, i) => `<div class="tr-ed-row">
        <input class="form-control" placeholder="Lesson title" value="${val(l.title)}" oninput="trEd('lessons.${i}.title', this.value)">
        <input class="form-control" placeholder="https://drive.google.com/…" value="${val(l.url)}" oninput="trEd('lessons.${i}.url', this.value)">
        <input class="form-control" type="number" min="0" placeholder="min" style="max-width:80px;" value="${val(l.minutes)}" oninput="trEd('lessons.${i}.minutes', this.value)">
        <button type="button" class="btn btn-ghost btn-sm" title="Remove" onclick="trAdminState.editor.lessons.splice(${i},1); renderTrainingEditor()">×</button>
      </div>`).join('')}
      <button type="button" class="btn btn-secondary btn-sm" onclick="trAdminState.editor.lessons.push({ title: '', url: '', minutes: '' }); renderTrainingEditor()">+ Lesson</button>
    </div>

    <div class="tr-ed-section">
      <div class="tr-ed-head"><b>Materials</b><span class="text-xs text-muted">PDFs, docs, sheets — any link.</span></div>
      ${ed.materials.map((m, i) => `<div class="tr-ed-row">
        <input class="form-control" placeholder="Name" value="${val(m.name)}" oninput="trEd('materials.${i}.name', this.value)">
        <input class="form-control" placeholder="https://…" value="${val(m.url)}" oninput="trEd('materials.${i}.url', this.value)">
        <button type="button" class="btn btn-ghost btn-sm" title="Remove" onclick="trAdminState.editor.materials.splice(${i},1); renderTrainingEditor()">×</button>
      </div>`).join('')}
      <button type="button" class="btn btn-secondary btn-sm" onclick="trAdminState.editor.materials.push({ name: '', url: '' }); renderTrainingEditor()">+ Material</button>
    </div>

    <div class="tr-ed-section">
      <div class="tr-ed-head"><b>Quiz</b><span class="text-xs text-muted">Optional. Scored on the server; learners never see the answers.</span></div>
      ${ed.quiz.map((q, i) => `<div class="tr-ed-q">
        <div class="tr-ed-row">
          <select class="form-control" style="max-width:170px;" onchange="trEd('quiz.${i}.type', this.value); if(this.value==='true_false'){trEd('quiz.${i}.options',['True','False']); trEd('quiz.${i}.answer','True');} if(this.value==='multiple_choice' && (!trAdminState.editor.quiz[${i}].options||trAdminState.editor.quiz[${i}].options.length<2)){trEd('quiz.${i}.options',['','']);} renderTrainingEditor()">
            ${[['multiple_choice', 'Multiple choice'], ['true_false', 'True / False'], ['short_answer', 'Short answer']].map(([v, l]) => `<option value="${v}"${q.type === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
          <input class="form-control" placeholder="Question ${i + 1}" value="${val(q.question)}" oninput="trEd('quiz.${i}.question', this.value)">
          <input class="form-control" type="number" min="1" style="max-width:80px;" title="Points" value="${val(q.points)}" oninput="trEd('quiz.${i}.points', this.value)">
          <button type="button" class="btn btn-ghost btn-sm" title="Remove question" onclick="trAdminState.editor.quiz.splice(${i},1); renderTrainingEditor()">×</button>
        </div>
        ${q.type === 'multiple_choice' ? `<div class="tr-ed-options">
          ${(q.options || []).map((o, j) => `<label class="tr-ed-option"><input type="radio" name="tr-ans-${i}" title="Correct answer"${o && o === q.answer ? ' checked' : ''} onchange="trEd('quiz.${i}.answer', trAdminState.editor.quiz[${i}].options[${j}])">
            <input class="form-control" placeholder="Option ${j + 1}" value="${val(o)}" oninput="const wasAnswer = trAdminState.editor.quiz[${i}].answer === trAdminState.editor.quiz[${i}].options[${j}]; trEd('quiz.${i}.options.${j}', this.value); if (wasAnswer) trEd('quiz.${i}.answer', this.value)">
            ${(q.options || []).length > 2 ? `<button type="button" class="btn btn-ghost btn-sm" onclick="trAdminState.editor.quiz[${i}].options.splice(${j},1); renderTrainingEditor()">×</button>` : ''}</label>`).join('')}
          <button type="button" class="btn btn-ghost btn-sm" onclick="trAdminState.editor.quiz[${i}].options.push(''); renderTrainingEditor()">+ Option</button>
          <span class="text-xs text-muted">Pick the correct one with its radio button.</span>
        </div>` : q.type === 'true_false' ? `<div class="tr-ed-options">Correct answer:
          ${['True', 'False'].map((o) => `<label class="tr-ed-option"><input type="radio" name="tr-ans-${i}"${q.answer === o ? ' checked' : ''} onchange="trEd('quiz.${i}.answer', '${o}')"> ${o}</label>`).join('')}
        </div>` : `<div class="tr-ed-options"><input class="form-control" placeholder="Accepted answers, separated by |  (e.g. Pancake | Pancake POS)" value="${val(q.answer)}" oninput="trEd('quiz.${i}.answer', this.value)"></div>`}
      </div>`).join('')}
      <button type="button" class="btn btn-secondary btn-sm" onclick="trAdminState.editor.quiz.push(trBlankQuestion()); renderTrainingEditor()">+ Question</button>
    </div>

    <div class="tr-ed-section">
      <div class="tr-ed-head"><b>Assign to</b></div>
      <div class="tr-pills" style="margin-bottom:10px;">
        <label class="hrr-toggle"><input type="radio" name="tr-aud"${audience.all ? ' checked' : ''} onchange="trEd('audience', { all: true }); renderTrainingEditor()"> Everyone</label>
        <label class="hrr-toggle"><input type="radio" name="tr-aud"${audience.all ? '' : ' checked'} onchange="trEd('audience', { departments: [], user_ids: [] }); renderTrainingEditor()"> Selected departments / people</label>
      </div>
      ${audience.all ? '' : `
        <div class="tr-checks">${departments.map((d) => `<label class="hrr-toggle"><input type="checkbox"${(audience.departments || []).includes(d) ? ' checked' : ''} onchange="trToggleList('departments', ${escapeHtml(JSON.stringify(d))}, this.checked)"> ${escapeHtml(d)}</label>`).join('')}</div>
        <div class="text-xs text-muted" style="margin:10px 0 6px;">…and/or specific people</div>
        <div class="tr-checks tr-people">${trAdminState.users.map((u) => `<label class="hrr-toggle"><input type="checkbox"${(audience.user_ids || []).map(Number).includes(Number(u.id)) ? ' checked' : ''} onchange="trToggleList('user_ids', ${Number(u.id)}, this.checked)"> ${escapeHtml(u.name || 'User')}</label>`).join('')}</div>`}
      <div class="form-grid-2" style="margin-top:12px;">
        <div class="form-group"><label class="form-label">Due date (optional)</label><input type="date" class="form-control" value="${val(ed.due_date)}" oninput="trEd('due_date', this.value)"></div>
        <div class="form-group"><label class="form-label">&nbsp;</label><label class="hrr-toggle" style="margin-top:8px;"><input type="checkbox"${ed.required ? ' checked' : ''} onchange="trEd('required', this.checked)"> Required training</label></div>
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-primary" onclick="saveTrainingEditor('published')">${ed.status === 'published' ? 'Save' : 'Save &amp; Publish'}</button>
      <button class="btn btn-secondary" onclick="saveTrainingEditor('draft')">${ed.status === 'published' ? 'Unpublish (draft)' : 'Save as Draft'}</button>
      ${ed.id ? `<button class="btn btn-ghost" style="margin-left:auto;color:var(--danger);" onclick="deleteTraining(${ed.id})">Delete training</button>` : ''}
    </div>`;
}

function trToggleList(key, value, on) {
  const audience = trAdminState.editor.audience;
  const list = new Set(audience[key] || []);
  if (on) list.add(value); else list.delete(value);
  audience[key] = [...list];
}

async function saveTrainingEditor(status) {
  const ed = trAdminState.editor;
  if (!String(ed.title || '').trim()) { showToast('warning', 'Add a title', 'Every training needs a title.'); return; }
  const incomplete = ed.quiz.findIndex((q) => !String(q.question || '').trim() || !String(q.answer || '').trim());
  if (incomplete !== -1) { showToast('warning', `Question ${incomplete + 1} is incomplete`, 'Each question needs its text and a correct answer.'); return; }
  if (status === 'published' && !ed.lessons.some((l) => String(l.url || '').trim()) && !ed.quiz.length) {
    showToast('warning', 'Nothing to learn yet', 'Add at least one lesson link or a quiz before publishing.'); return;
  }
  const body = { ...ed, status };
  try {
    await trApi(ed.id ? `/admin/trainings/${ed.id}` : '/admin/trainings', { method: ed.id ? 'PUT' : 'POST', body });
    closeModal('tr-editor-modal');
    showToast('success', status === 'published' ? 'Published' : 'Saved as draft', ed.title);
    await initTrainingManagePage();
  } catch (error) {
    showToast('error', 'Could not save', error.message || 'Please try again.');
  }
}

async function deleteTraining(id) {
  const training = trAdminState.trainings.find((t) => t.id === Number(id));
  if (!training || !confirm(`Delete "${training.title}"? Everyone's progress on it is removed; certificates already earned are kept.`)) return;
  try {
    await trApi(`/admin/trainings/${Number(id)}`, { method: 'DELETE' });
    closeModal('tr-editor-modal');
    await initTrainingManagePage();
  } catch (error) {
    showToast('error', 'Could not delete', error.message || 'Please try again.');
  }
}

function renderTrainingCategoriesModal() {
  return `
  <div class="modal-overlay" id="tr-cat-modal">
    <div class="modal" style="max-width:480px;">
      <div class="modal-header">
        <div class="modal-title">Training Categories</div>
        <button class="modal-close" onclick="closeModal('tr-cat-modal')">&times;</button>
      </div>
      <div class="modal-body" id="tr-cat-body"></div>
    </div>
  </div>`;
}

function openTrainingCategories() {
  renderTrainingCategories();
  openModal('tr-cat-modal');
}

function renderTrainingCategories() {
  const body = document.getElementById('tr-cat-body');
  if (!body) return;
  const counts = new Map();
  trAdminState.trainings.forEach((t) => counts.set(t.category, (counts.get(t.category) || 0) + 1));
  body.innerHTML = `
    ${trAdminState.categories.map((c) => `<div class="tr-ed-row">
      <input class="form-control" value="${escapeHtml(c.name)}" onchange="renameTrainingCategory(${Number(c.id)}, this.value)">
      <span class="text-xs text-muted" style="white-space:nowrap;">${counts.get(c.name) || 0} training${counts.get(c.name) === 1 ? '' : 's'}</span>
      <button class="btn btn-ghost btn-sm" title="Delete" onclick="deleteTrainingCategory(${Number(c.id)})">×</button>
    </div>`).join('')}
    <div class="tr-ed-row" style="margin-top:12px;">
      <input class="form-control" id="tr-cat-new" placeholder="New category">
      <button class="btn btn-primary btn-sm" onclick="addTrainingCategory()">Add</button>
    </div>
    <p class="text-xs text-muted">Renaming moves its trainings with it. A category still in use cannot be deleted.</p>`;
}

async function trReloadCategories() {
  const [categories, trainings] = await Promise.all([trApi('/categories'), trApi('/admin/trainings')]);
  trAdminState.categories = categories.categories || [];
  trAdminState.trainings = trainings.trainings || [];
  renderTrainingCategories();
  renderTrainingAdminList();
}

async function addTrainingCategory() {
  const name = document.getElementById('tr-cat-new')?.value || '';
  if (!name.trim()) return;
  try { await trApi('/admin/categories', { method: 'POST', body: { name } }); await trReloadCategories(); } catch (error) { showToast('error', 'Could not add', error.message); }
}

async function renameTrainingCategory(id, name) {
  try { await trApi(`/admin/categories/${id}`, { method: 'PUT', body: { name } }); await trReloadCategories(); } catch (error) { showToast('error', 'Could not rename', error.message); await trReloadCategories(); }
}

async function deleteTrainingCategory(id) {
  try { await trApi(`/admin/categories/${id}`, { method: 'DELETE' }); await trReloadCategories(); } catch (error) { showToast('error', 'Could not delete', error.message); }
}

// ─── TRAINING REPORTS (HR) ─────────────────────────────────
const trReportState = { data: null, department: '' };

function renderTrainingReportsPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Training Reports</h1>
      <p>Who has finished what: completion by training and by employee, overdue assignments, and quiz scores.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="exportTrainingReport()">Export CSV</button>
    </div>
  </div>
  <div id="tr-rep-root"><div class="card"><div class="empty-state"><h3>Loading</h3></div></div></div>`;
}

async function initTrainingReportsPage() {
  try {
    trReportState.data = await trApi('/admin/report');
  } catch (error) {
    const root = document.getElementById('tr-rep-root');
    if (root) root.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  renderTrainingReports();
}

// One cell of the matrix: the learner's status on a training, or blank when
// the training is neither assigned to them nor started.
function trCell(data, user, training) {
  const progress = data.progress.find((p) => p.user_id === user.id && p.training_id === training.id);
  const assigned = training.assigned_user_ids.includes(user.id);
  if (!progress && !assigned) return null;
  const status = progress?.status || 'not_started';
  const overdue = assigned && training.due_date && training.due_date < data.today && status !== 'completed';
  return { status, overdue, assigned, score: progress?.best_score ?? null, completed_at: progress?.completed_at };
}

function renderTrainingReports() {
  const root = document.getElementById('tr-rep-root');
  const data = trReportState.data;
  if (!root || !data) return;
  const users = data.users.filter((u) => !trReportState.department || u.department === trReportState.department);
  const departments = [...new Set(data.users.map((u) => u.department))].sort();
  let seats = 0;
  let done = 0;
  let overdueCount = 0;
  const scores = [];
  const perTraining = data.trainings.map((t) => {
    const counts = { assigned: 0, completed: 0, in_progress: 0, failed: 0, not_started: 0, overdue: 0 };
    const tScores = [];
    users.forEach((u) => {
      const cell = trCell(data, u, t);
      if (!cell || !cell.assigned) return;
      counts.assigned += 1;
      counts[cell.status] = (counts[cell.status] || 0) + 1;
      if (cell.overdue) counts.overdue += 1;
      if (cell.score !== null) tScores.push(Number(cell.score));
    });
    seats += counts.assigned; done += counts.completed; overdueCount += counts.overdue; scores.push(...tScores);
    return { t, counts, avg: tScores.length ? Math.round(tScores.reduce((a, b) => a + b, 0) / tScores.length) : null };
  });
  const stat = (tone, label, value, meta) => `<div class="stat-card ${tone}"><div class="stat-card-accent"></div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div><div class="stat-meta">${escapeHtml(meta)}</div></div>`;
  const chip = (cell) => {
    if (!cell) return '<span class="text-muted">·</span>';
    const tone = cell.overdue ? 'danger' : (TR_STATUS[cell.status] || TR_STATUS.not_started).tone;
    const label = cell.status === 'completed' ? (cell.score !== null ? `${Math.round(cell.score)}%` : '✓') : cell.overdue ? 'Overdue' : cell.status === 'in_progress' ? '…' : cell.status === 'failed' ? '✗' : '—';
    const title = `${(TR_STATUS[cell.status] || TR_STATUS.not_started).label}${cell.overdue ? ' · overdue' : ''}${cell.assigned ? '' : ' · not assigned'}`;
    return `<span class="badge badge-${tone}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  };
  root.innerHTML = `
    <div class="stats-grid">
      ${stat('blue', 'Published Trainings', data.trainings.length, `${seats} assignments`)}
      ${stat('green', 'Completion Rate', seats ? `${Math.round((done / seats) * 100)}%` : '—', `${done} of ${seats} assignments done`)}
      ${stat('red', 'Overdue', overdueCount, 'assigned, past due, not done')}
      ${stat('amber', 'Avg Quiz Score', scores.length ? `${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}%` : '—', 'best score per learner')}
    </div>
    <div class="tr-pills" style="margin-bottom:14px;">
      <button class="filter-pill${!trReportState.department ? ' active' : ''}" onclick="trReportState.department=''; renderTrainingReports()">All departments</button>
      ${departments.map((d) => `<button class="filter-pill${trReportState.department === d ? ' active' : ''}" onclick="trReportState.department=${escapeHtml(JSON.stringify(d))}; renderTrainingReports()">${escapeHtml(d)}</button>`).join('')}
    </div>
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header"><div><div class="card-title">By training</div></div></div>
      <div class="card-body">${perTraining.length ? `<div class="table-container"><table>
        <thead><tr><th>Training</th><th>Assigned</th><th>Completed</th><th>In Progress</th><th>Failed</th><th>Not Started</th><th>Overdue</th><th>Avg Score</th><th style="min-width:160px;">Completion</th></tr></thead>
        <tbody>${perTraining.map(({ t, counts, avg }) => {
          const pct = counts.assigned ? Math.round((counts.completed / counts.assigned) * 100) : 0;
          return `<tr><td><strong>${escapeHtml(t.title)}</strong><div class="text-xs text-muted">${escapeHtml(t.category || '')}${t.due_date ? ` · due ${escapeHtml(trDate(t.due_date))}` : ''}</div></td>
            <td>${counts.assigned}</td><td>${counts.completed}</td><td>${counts.in_progress}</td><td>${counts.failed}</td><td>${counts.not_started}</td>
            <td>${counts.overdue ? `<span class="badge badge-danger">${counts.overdue}</span>` : '0'}</td><td>${avg === null ? '—' : `${avg}%`}</td>
            <td><span class="tr-bar tr-bar-inline"><span style="width:${pct}%;"></span></span> <span class="text-xs">${pct}%</span></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state"><p>No published trainings yet.</p></div>'}</div>
    </div>
    <div class="card">
      <div class="card-header"><div><div class="card-title">By employee</div><div class="card-subtitle">Score = best quiz score · ✓ done (no quiz) · … in progress · ✗ failed · — not started · red = overdue. Blank = not assigned.</div></div></div>
      <div class="card-body">${data.trainings.length && users.length ? `<div class="table-container hrr-scroll"><table>
        <thead><tr><th>Employee</th><th>Department</th>${data.trainings.map((t) => `<th title="${escapeHtml(t.title)}">${escapeHtml(t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title)}</th>`).join('')}<th>Done</th></tr></thead>
        <tbody>${users.map((u) => {
          const cells = data.trainings.map((t) => trCell(data, u, t));
          const assigned = cells.filter((c) => c?.assigned);
          return `<tr><td><strong>${escapeHtml(u.name)}</strong></td><td>${escapeHtml(u.department)}</td>
            ${cells.map((c) => `<td style="text-align:center;">${chip(c)}</td>`).join('')}
            <td>${assigned.filter((c) => c.status === 'completed').length}/${assigned.length}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state"><p>Nothing to show yet.</p></div>'}</div>
    </div>`;
}

function exportTrainingReport() {
  const data = trReportState.data;
  if (!data) return;
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Employee', 'Department', 'Training', 'Category', 'Assigned', 'Status', 'Overdue', 'Best Score', 'Completed At'].map(quote).join(',')];
  data.users.filter((u) => !trReportState.department || u.department === trReportState.department).forEach((u) => {
    data.trainings.forEach((t) => {
      const cell = trCell(data, u, t);
      if (!cell) return;
      lines.push([u.name, u.department, t.title, t.category, cell.assigned ? 'Yes' : 'No', (TR_STATUS[cell.status] || TR_STATUS.not_started).label.replace(' — retry', ''), cell.overdue ? 'Yes' : 'No', cell.score ?? '', cell.completed_at ? String(cell.completed_at).slice(0, 10) : ''].map(quote).join(','));
    });
  });
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `training-report-${data.today}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
