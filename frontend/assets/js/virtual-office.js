/* ═══════════════════════════════════════════════════════════
   VIRTUAL OFFICE — today's attendance as a 3D floor
   An isometric office floor: every active account is a cartoon character
   with a seat at its department's bench (Logistics: a packing table in the
   warehouse), each bench marked by a feature wall in the team's colour with
   its name on it. Timed in → at the desk; lunch or the 15-minute break →
   the lounge; timed out → walks out the front. Not timed in yet → no
   character, just an empty seat. Backed by /api/virtual-office
   (HR and the super admin only), polled every 30 seconds.
   Three.js is fetched only when the page opens, so nobody else pays for it.
   Loaded before app.js; it leans on app.js globals (App, escapeHtml,
   authorizedJsonRequest, employeeDepartment, DEPARTMENT_ORDER) read at
   call time.
   ═══════════════════════════════════════════════════════════ */

const VO_THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js';
const VO_POLL_MS = 30000;
const VO_WALK_SPEED = 2.4; // floor units per second
const VO_MAX_VIEW = 90;     // widest the camera zooms out, in floor units of view height

const VO_STATUS = {
  working: { label: 'At desk', color: '#059669' },
  lunch: { label: 'Lunch break', color: '#f59e0b' },
  break: { label: '15-min break', color: '#3b82f6' },
  left: { label: 'Timed out', color: '#94a3b8' },
  not_in: { label: 'Not in yet', color: '#cbd5e1' },
};
// Team colour: shirts, the bench divider and the team's wall.
const VO_DEPT_COLOR = {
  Management: '#7a6aa6',
  'Human Resources': '#c0687f',
  Operations: '#3f8f88',
  'Sales & Marketing': '#d0814f',
  CSR: '#4f74ad',
  RMO: '#5f9a63',
  Logistics: '#c79a3e',
  Trainee: '#7d8794',
  Unassigned: '#66707c',
};
const VO_SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const VO_HAIR = ['#2b1b0e', '#4a2c17', '#111111', '#6b3e1f', '#3b2a1a'];

// Floor plan, in floor units. Back wall along z = 0, left wall along x = 0;
// the camera looks in from the open front-right corner. Left to right: a desk
// zone, the lounge (the break room), a second desk zone. A row of rooms runs
// along the back wall: meeting rooms, the café counter, the warehouse.
const VO_ZONE_W = 12;
const VO_WALK_W = 3;        // the walkway between the two desk zones
const VO_LOUNGE_D = 9.4;    // depth of the lounge room
const VO_BACK_MIN = 5.6;    // depth of the back row of rooms
const VO_ROW_D = 2.6;       // one bench row: chairs, table, chairs
const VO_AISLE = 1.4;
const VO_FRONT_WALK = 1.8;
const VO_SEAT_W = 1.25;     // bench length per person
const VO_MAX_PER_BENCH = 16;
const VO_LEFT_ROWS = 4;     // bench rows on the left before the right takes any
const VO_WALL_H = 2.8;
const VO_DESK_W = 1.7;      // packing table width in the warehouse
const VO_WAREHOUSE_DEPT = 'Logistics';
// Management works in the two glass offices in the back-left corner.
const VO_OFFICE_DEPT = 'Management';
const VO_OFFICE_SEATS = 12; // six round each office table
const VO_KRAFT = '#c8a165'; // parcel-box cardboard
// Break limits (attendance policy: a 1-hour lunch, a 15-minute break).
const VO_LUNCH_LIMIT = 60;
const VO_BREAK_LIMIT = 15;
// Zoomed in closer than this (view height in floor units), every name tag,
// desk plate and work counter shows; further out only the ones that need
// attention do.
const VO_DETAIL_VIEW = 17;
const VO_IN = ['working', 'lunch', 'break'];

const voState = {
  people: [],
  date: '',
  time: '',
  error: '',
  loading: false,
  scene: null,
  timer: null,
  focusId: null,
  cardId: null,
  kpis: null,
  // Minutes after midnight being replayed, or null for live.
  replay: null,
};

function voReady() {
  if (window.THREE) return Promise.resolve();
  if (voReady.pending) return voReady.pending;
  voReady.pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = VO_THREE_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { voReady.pending = null; reject(new Error('Could not load the 3D library.')); };
    document.head.appendChild(script);
  });
  return voReady.pending;
}

function voHash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// HH:MM → minutes after midnight, and back.
function voToMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function voClock(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function voDuration(mins) {
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// The moment being shown: the replay time, or the server's "now".
function voAt() {
  return voState.replay !== null ? voState.replay : (voToMin(voState.time) ?? 0);
}

// Where someone was at a given minute, from the day's punches — the same
// rules as the server's officeStatus, replayed.
function voStatusAt(p, at) {
  const punch = (key) => {
    const v = p.punches?.[key];
    return v && voToMin(v) <= at ? v : null;
  };
  const r = {
    time_in: punch('time_in'), break_out: punch('break_out'), break_in: punch('break_in'),
    break2_out: punch('break2_out'), break2_in: punch('break2_in'), time_out: punch('time_out'),
  };
  if (!r.time_in) return { status: 'not_in', since: null };
  if (r.time_out) return { status: 'left', since: r.time_out };
  if (r.break_out && !r.break_in) return { status: 'lunch', since: r.break_out };
  if (r.break2_out && !r.break2_in) return { status: 'break', since: r.break2_out };
  const back = [r.time_in, r.break_in, r.break2_in].filter(Boolean).sort();
  return { status: 'working', since: back[back.length - 1] };
}

// Minutes a break ran (still running counts up to `at`), or null if it was
// not taken by then.
function voBreakMinutes(out, back, at) {
  const o = voToMin(out);
  if (o === null || o > at) return null;
  const b = voToMin(back);
  return (b !== null && b <= at ? b : at) - o;
}

// What the day looks like for someone at a minute: late, absent, rest day,
// on leave, and each break with how far over its limit it ran.
function voFlags(p, view, at) {
  const f = {};
  const timeIn = voToMin(p.punches?.time_in);
  const shift = voToMin(p.shift?.start);
  const inBy = timeIn !== null && timeIn <= at;
  if (p.standing === 'on_leave') f.leave = p.leave_type || 'Leave';
  else if (p.standing === 'rest_day' && !inBy) f.rest = true;
  else if (inBy && shift !== null && timeIn > shift) f.late = timeIn - shift;
  else if (!inBy && shift !== null && at > shift) f.absent = true;
  const lunch = voBreakMinutes(p.punches?.break_out, p.punches?.break_in, at);
  const brk = voBreakMinutes(p.punches?.break2_out, p.punches?.break2_in, at);
  if (lunch !== null) { f.lunch = lunch; if (lunch > VO_LUNCH_LIMIT) f.overLunch = lunch - VO_LUNCH_LIMIT; }
  if (brk !== null) { f.brk = brk; if (brk > VO_BREAK_LIMIT) f.overBreak = brk - VO_BREAK_LIMIT; }
  // Over the limit right now, on the break that is still open.
  if (view.status === 'lunch' && f.overLunch) f.overNow = f.overLunch;
  if (view.status === 'break' && f.overBreak) f.overNow = f.overBreak;
  return f;
}

// Everyone as of the moment shown: live from the server, or replayed.
function voView() {
  const live = voState.replay === null;
  const at = voAt();
  return voState.people.map((p) => {
    const view = live ? { status: p.status, since: p.since } : voStatusAt(p, at);
    return { ...p, ...view, flags: voFlags(p, view, at) };
  });
}

// The note on a name tag: an open over-break in red, a late time-in in amber.
function voTagNote(p) {
  const f = p.flags || {};
  if (f.overNow) return { note: `${voDuration(p.status === 'lunch' ? f.lunch : f.brk)} ${p.status === 'lunch' ? 'lunch' : 'break'}`, tone: 'alert' };
  if (f.late && p.status === 'working') return { note: `Late ${voDuration(f.late)}`, tone: 'warn' };
  return { note: '', tone: '' };
}

function voFormatSince(person) {
  if (!person.since) return '';
  const mins = Math.max(0, voAt() - (voToMin(person.since) ?? voAt()));
  const verb = person.status === 'left' ? 'out at' : 'since';
  return `${verb} ${person.since}${person.status === 'left' ? '' : ` · ${voDuration(mins)}`}`;
}

// Departments in org order. Inside a team: the seat order HR set, then team
// leads, then by name — so seat 1, next to the team wall, is the lead unless
// HR says otherwise, and a seat stays put from one refresh to the next.
function voDepartments(people) {
  const groups = new Map();
  people.forEach((person) => {
    const dept = employeeDepartment(person);
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept).push(person);
  });
  const rank = (name) => { const i = DEPARTMENT_ORDER.indexOf(name); return i === -1 ? DEPARTMENT_ORDER.length : i; };
  const order = (p) => (p.desk_order === null || p.desk_order === undefined ? 1e6 : Number(p.desk_order));
  const lead = (p) => (/\bTL\b/i.test(String(p.role || '')) ? 0 : 1);
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, members]) => [name, members.sort((a, b) => order(a) - order(b)
      || lead(a) - lead(b)
      || String(a.name).localeCompare(String(b.name)))]);
}

/* ─── PAGE ─────────────────────────────────────────────────── */

function renderVirtualOfficePage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>Virtual Office</h1>
      <p>Who is at their desk, on break or gone for the day — live from Time &amp; Attendance.</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick="voExportDay()">Export day (CSV)</button>
      <button class="btn btn-secondary btn-sm" onclick="voResetView()">Reset view</button>
      <button class="btn btn-secondary btn-sm" onclick="voRefresh()">Refresh</button>
    </div>
  </div>
  <div class="vo-layout">
    <div class="card vo-stage-card">
      <div class="vo-stage-wrap">
        <div class="vo-stage" id="vo-stage">
          <div class="vo-stage-msg" id="vo-stage-msg">Loading the office…</div>
        </div>
        <div class="vo-card hidden" id="vo-card"></div>
      </div>
      <div class="vo-replay">
        <button class="vo-live on" id="vo-live" onclick="voSetReplay(null)" title="Back to now">● Live</button>
        <input type="range" id="vo-replay" min="360" max="1380" step="5" value="1380" oninput="voSetReplay(Number(this.value))" aria-label="Replay the day">
        <span class="vo-replay-time" id="vo-replay-time">Now</span>
      </div>
      <div class="vo-legend">
        ${['working', 'lunch', 'break'].map((s) => `<span><i style="background:${VO_STATUS[s].color}"></i>${VO_STATUS[s].label}</span>`).join('')}
        <span><i style="background:#dc2626"></i>Over break / absent</span>
        <span class="vo-hint">Drag to turn · scroll or pinch to zoom · click someone for details</span>
      </div>
    </div>
    <div class="card vo-side" id="vo-side"></div>
  </div>`;
}

async function initVirtualOfficePage() {
  voState.focusId = null;
  await voLoad();
  try {
    await voReady();
  } catch (error) {
    const msg = document.getElementById('vo-stage-msg');
    if (msg) msg.textContent = `${error.message} Check the connection and refresh.`;
    return;
  }
  if (App.currentPage !== 'virtual-office') return;
  voBuildScene();
  clearInterval(voState.timer);
  voState.timer = setInterval(() => {
    if (App.currentPage !== 'virtual-office' || !document.getElementById('vo-stage')) {
      clearInterval(voState.timer);
      voState.timer = null;
      return;
    }
    voLoad().catch(() => {});
  }, VO_POLL_MS);
}

async function voLoad() {
  voState.loading = true;
  try {
    const data = await authorizedJsonRequest('/virtual-office');
    voState.people = Array.isArray(data?.people) ? data.people : [];
    voState.date = data?.date || '';
    voState.time = data?.time || '';
    voState.kpis = data?.kpis || null;
    voState.error = '';
  } catch (error) {
    voState.error = error.message || 'Could not load attendance.';
  }
  voState.loading = false;
  voSyncReplayControl();
  voRenderSide();
  voRenderCard();
  if (voState.scene) voSyncPeople();
}

function voRefresh() {
  voLoad().catch(() => {});
}

// A short badge for the day's standing and work, shown on a list row.
function voBadges(m) {
  const f = m.flags || {};
  const out = [];
  if (f.overNow) out.push(`<b class="vo-badge is-alert">${voDuration(f.overNow)} over</b>`);
  if (f.absent) out.push('<b class="vo-badge is-alert">Absent</b>');
  if (f.late) out.push(`<b class="vo-badge is-warn">Late ${voDuration(f.late)}</b>`);
  if (f.rest) out.push('<b class="vo-badge is-muted">Rest day</b>');
  if (f.leave) out.push(`<b class="vo-badge is-muted">${escapeHtml(f.leave)}</b>`);
  if (m.output?.confirmed) out.push(`<b class="vo-badge is-good" title="Orders confirmed today">✓ ${m.output.confirmed}</b>`);
  if (m.output?.rts_scans) out.push(`<b class="vo-badge is-good" title="RTS parcels scanned today">↩ ${m.output.rts_scans}</b>`);
  return out.join('');
}

function voRenderSide() {
  const side = document.getElementById('vo-side');
  if (!side) return;
  if (voState.error) {
    side.innerHTML = `<div class="vo-side-empty" style="color:var(--danger)">${escapeHtml(voState.error)}</div>`;
    return;
  }
  const people = voView();
  const count = (s) => people.filter((p) => p.status === s).length;
  const tiles = ['working', 'lunch', 'break', 'left', 'not_in'].map((s) => `
    <div class="vo-count"><b style="color:${VO_STATUS[s].color}">${count(s)}</b><span>${VO_STATUS[s].label}</span></div>`).join('');

  // What HR should look at first: over break now, absent, late, and breaks
  // that already ran over today.
  const pick = (test) => people.filter(test);
  const name = (p, extra) => `<button class="vo-attn-name" onclick="voFocus(${Number(p.id)})">${escapeHtml(p.name)}${extra ? ` <small>${extra}</small>` : ''}</button>`;
  const groups = [
    ['Over break now', 'alert', pick((p) => p.flags.overNow), (p) => `${voDuration(p.status === 'lunch' ? p.flags.lunch : p.flags.brk)} ${p.status === 'lunch' ? 'lunch' : 'break'}`],
    ['Absent', 'alert', pick((p) => p.flags.absent), (p) => (p.shift?.start ? `shift ${p.shift.start}` : '')],
    ['Late today', 'warn', pick((p) => p.flags.late), (p) => `${voDuration(p.flags.late)} · in ${p.punches.time_in}`],
    ['Ran over a break', 'warn', pick((p) => !p.flags.overNow && (p.flags.overLunch || p.flags.overBreak)),
      (p) => [p.flags.overLunch && `lunch +${p.flags.overLunch}m`, p.flags.overBreak && `break +${p.flags.overBreak}m`].filter(Boolean).join(' · ')],
  ].filter(([, , list]) => list.length);
  const attention = groups.length
    ? groups.map(([title, tone, list, extra]) => `
      <div class="vo-attn is-${tone}">
        <div class="vo-attn-title">${title} <span>${list.length}</span></div>
        <div class="vo-attn-list">${list.map((p) => name(p, extra(p))).join('')}</div>
      </div>`).join('')
    : '<div class="vo-attn is-good"><div class="vo-attn-title">All good so far ✓</div></div>';

  const depts = voDepartments(people).map(([dept, members]) => `
    <div class="vo-dept">
      <div class="vo-dept-head"><i style="background:${VO_DEPT_COLOR[dept] || VO_DEPT_COLOR.Unassigned}"></i>${escapeHtml(dept)}
        <span>${members.filter((m) => VO_IN.includes(m.status)).length}/${members.length} in</span></div>
      ${members.map((m) => {
        const s = VO_STATUS[m.status] || VO_STATUS.not_in;
        const inside = VO_IN.includes(m.status);
        const id = Number(m.id);
        const look = m.avatar_gender || '';
        // Clicking the look already set clears it back to neutral.
        const avatar = [['male', 'M', 'Male'], ['female', 'F', 'Female']].map(([g, t, label]) => `
          <button class="${look === g ? 'on' : ''}" title="Character: ${label}${look === g ? ' (click to clear)' : ''}" onclick="voSetAvatar(${id}, '${look === g ? '' : g}')">${t}</button>`).join('');
        const dot = m.flags.overNow || m.flags.absent ? '#dc2626' : s.color;
        return `<div class="vo-person-row${voState.focusId === m.id ? ' active' : ''}${inside ? '' : ' away'}">
          <button class="vo-person" onclick="voFocus(${id})">
            <i style="background:${dot}"></i>
            <span class="vo-person-main">
              <span class="vo-person-name">${escapeHtml(m.name)}</span>
              <span class="vo-badges">${voBadges(m)}</span>
            </span>
            <span class="vo-person-status">${s.label}${m.since ? ` <small>${escapeHtml(voFormatSince(m))}</small>` : ''}</span>
          </button>
          <span class="vo-avatar">${avatar}</span>
        </div>`;
      }).join('')}
    </div>`).join('');
  const when = voState.replay !== null ? `Replay · ${voClock(voState.replay)}` : `Today${voState.time ? ` · ${escapeHtml(voState.time)}` : ''}`;
  side.innerHTML = `
    <div class="vo-side-head">${when}</div>
    <div class="vo-counts">${tiles}</div>
    <div class="vo-attention">${attention}</div>
    <div class="vo-depts">${depts || '<div class="vo-side-empty">No active accounts.</div>'}</div>`;
}

/* ─── SCENE ────────────────────────────────────────────────── */

function voMat(color) {
  return new THREE.MeshLambertMaterial({ color });
}

// Text drawn on a canvas: a name tag (with a status dot) or lettering for a wall.
function voTextTexture(text, { color = '#0f172a', bg = 'rgba(255,255,255,0.92)', dot = null, size = 34, weight = 600 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  ctx.font = font;
  const pad = 18;
  const dotW = dot ? size * 0.9 : 0;
  const width = Math.ceil(ctx.measureText(text).width + pad * 2 + dotW);
  const height = Math.ceil(size * 1.7);
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  if (bg) {
    ctx.fillStyle = bg;
    const r = height / 2;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(width - r, 0); ctx.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(r, height); ctx.arc(r, r, r, Math.PI / 2, -Math.PI / 2); ctx.fill();
  }
  if (dot) {
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(pad + size * 0.3, height / 2, size * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad + dotW, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return { texture, aspect: width / height };
}

// A name tag; with a note ("65m lunch", "Late 12m") it reads "Name · note",
// red for an alert, amber for a heads-up.
function voNameSprite(name, status, note = '', tone = '') {
  const tones = { alert: ['#fee2e2', '#991b1b'], warn: ['#fef3c7', '#92400e'] };
  const [bg, color] = tones[tone] || ['rgba(255,255,255,0.92)', '#0f172a'];
  const dot = tone === 'alert' ? '#dc2626' : (VO_STATUS[status] || VO_STATUS.working).color;
  const { texture, aspect } = voTextTexture(note ? `${name} · ${note}` : name, { dot, bg, color });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  // Sized every frame against the zoom (voTick), so names stay readable.
  sprite.userData.aspect = aspect;
  sprite.renderOrder = 10;
  return sprite;
}

// Lettering painted straight onto a wall: a plane just off its surface.
function voWallText(root, text, color, height, x, y, z, rotY = 0) {
  const { texture, aspect } = voTextTexture(text, { color, bg: null, size: 72, weight: 800 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  root.add(mesh);
  return mesh;
}

// The face of a team's feature wall: its colour, its name in big white
// letters (wrapped to fit), and a thin rule under it.
function voTeamWallTexture(name, color, aspect) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 / aspect);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const words = name.toUpperCase().split(/\s+/);
  let size = 96;
  let lines = [];
  const fit = () => {
    ctx.font = `800 ${size}px Inter, system-ui, sans-serif`;
    lines = [];
    let line = '';
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > canvas.width - 70 && line) { lines.push(line); line = word; } else line = next;
    });
    lines.push(line);
    return lines.every((l) => ctx.measureText(l).width <= canvas.width - 70) && lines.length * size * 1.1 < canvas.height - 120;
  };
  while (size > 28 && !fit()) size -= 6;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const top = canvas.height / 2 - ((lines.length - 1) * size * 1.1) / 2 - 20;
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, top + i * size * 1.1));
  ctx.fillRect(canvas.width / 2 - 60, top + (lines.length - 1) * size * 1.1 + size * 0.75, 120, 8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

// One palm frond as a texture: a midrib with narrow leaflets down both
// sides, longest in the middle, on a transparent background.
function voFrondTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#5f7f3a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(64, 256);
  ctx.lineTo(64, 6);
  ctx.stroke();
  const greens = ['#3f7a3a', '#4f8f43', '#5fa04c', '#467f3c'];
  for (let i = 0; i < 26; i += 1) {
    const t = i / 26;
    const y = 250 - t * 240;
    const len = Math.sin(Math.PI * (0.12 + t * 0.88)) * 58 + 6;
    [-1, 1].forEach((side) => {
      ctx.strokeStyle = greens[(i + (side > 0 ? 1 : 0)) % greens.length];
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(64, y);
      ctx.quadraticCurveTo(64 + side * len * 0.6, y - 10, 64 + side * len, y - 22);
      ctx.stroke();
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

// The frond's shape: a long strip based at the origin, rising along +y and
// curving toward +z, so tilted outward it arches over and droops.
function voFrondGeometry() {
  const geo = new THREE.PlaneGeometry(0.5, 1.1, 1, 8);
  geo.translate(0, 0.55, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i) / 1.1;
    pos.setZ(i, 0.45 * y * y);
  }
  geo.computeVertexNormals();
  return geo;
}

// Beige office tiles for the floor: a two-tone checker with grout lines,
// drawn once (2 × 2 tiles) and repeated.
function voTileTexture(dark) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const [a, b, grout] = dark ? ['#4b4337', '#433c31', '#3a342b'] : ['#ecdbbf', '#e2cdab', '#d4bd98'];
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      ctx.fillStyle = (i + j) % 2 ? b : a;
      ctx.fillRect(i * 128, j * 128, 128, 128);
    }
  }
  ctx.fillStyle = grout;
  [0, 128].forEach((v) => { ctx.fillRect(v, 0, 3, 256); ctx.fillRect(0, v, 256, 3); });
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// Where everything goes. Departments become benches packed into the two desk
// zones (whichever zone is emptier takes the next bench); Logistics works in
// the warehouse instead. Every seat carries its way out: along its aisle to
// the walkway ("spine") at the zone's lounge edge. Spines and the front
// walkway are the only routes across the floor (see voRoute).
function voLayout(departments) {
  const W = VO_ZONE_W * 2 + VO_WALK_W;
  const xL = VO_ZONE_W;
  const xR = VO_ZONE_W + VO_WALK_W;
  const spineL = xL + 0.7;
  const spineR = xR - 0.7;

  // Warehouse first: it may need the back row deeper than the default.
  const logistics = (departments.find(([d]) => d === VO_WAREHOUSE_DEPT) || [null, []])[1];
  const whStart = xR + 1.5; // a clear lane down the warehouse's door side
  const whCols = Math.max(1, Math.floor((W - 0.4 - whStart) / VO_DESK_W));
  const pods = Math.max(1, Math.ceil(logistics.length / (whCols * 2)));
  const back = Math.max(VO_BACK_MIN, 5.8 + (pods - 1) * 3.4);
  const backAisle = back + VO_AISLE / 2;
  const whLaneX = xR + 0.7;
  const seats = [];
  logistics.forEach((person, i) => {
    const pod = Math.floor(i / (whCols * 2));
    const j = i % (whCols * 2);
    const col = Math.floor(j / 2);
    const front = j % 2 === 1;
    const x = whStart + col * VO_DESK_W + VO_DESK_W / 2;
    const aisleZ = front ? 5.0 + pod * 3.4 : (pod === 0 ? 1.5 : 5.0 + (pod - 1) * 3.4);
    seats.push({
      person,
      x,
      z: front ? 4.3 + pod * 3.4 : 2.1 + pod * 3.4,
      deskZ: front ? 3.6 + pod * 3.4 : 2.8 + pod * 3.4,
      face: front ? Math.PI : 0,
      stand: true,
      exit: [{ x, z: aisleZ }, { x: whLaneX, z: aisleZ }, { x: whLaneX, z: backAisle }, { x: spineR, z: backAisle, line: 'R' }],
    });
  });
  const whUsedCols = Math.min(whCols, Math.ceil(logistics.length / 2));

  // Management takes the office tables, six to a room; anyone past twelve
  // falls back to a bench. Out of an office: round the table on the lane
  // behind or in front of the chairs, through the doorway at the room's
  // right, to the left spine.
  const roomW = VO_ZONE_W / 2;
  const office = (departments.find(([d]) => d === VO_OFFICE_DEPT) || [null, []])[1];
  office.slice(0, VO_OFFICE_SEATS).forEach((person, i) => {
    const room = Math.floor(i / 6);
    const j = i % 6;
    const front = j % 2 === 1;
    const rcz = back / 2 + 0.3;
    const x = roomW * room + roomW / 2 + ((j >> 1) - 1) * 0.9;
    const doorX = roomW * (room + 1) - 0.8;
    const laneZ = front ? back - 0.75 : 1.4;
    seats.push({
      person,
      x,
      z: rcz + (front ? 0.95 : -0.95),
      deskZ: rcz,
      face: front ? Math.PI : 0,
      stand: false,
      office: true,
      exit: [{ x, z: laneZ }, { x: doorX, z: laneZ }, { x: doorX, z: backAisle }, { x: spineL, z: backAisle, line: 'L' }],
    });
  });

  // Benches: one per department (split past VO_MAX_PER_BENCH people).
  // Benches fill the left side row after row. The right side opens with the
  // lounge (the break room, a glass room under the warehouse) and only takes
  // benches, below the lounge, once the left side has VO_LEFT_ROWS rows.
  const pitch = VO_ROW_D + VO_AISLE;
  const loungeRows = Math.ceil((VO_LOUNGE_D + 0.4) / pitch);
  const zones = [
    { side: 'L', spine: spineL, edge: xL - 0.6, dir: -1, startZ: back + VO_AISLE, rows: [{ used: 0, blocks: [] }] },
    { side: 'R', spine: spineR, edge: xR + 0.6, dir: 1, startZ: back + VO_AISLE + loungeRows * pitch, rows: [{ used: 0, blocks: [] }] },
  ];
  const lounge = {
    side: 'R',
    spine: spineR,
    x0: xR + 0.3,
    x1: W - 0.3,
    z0: back + VO_AISLE,
    z1: back + VO_AISLE + VO_LOUNGE_D,
  };
  const room = VO_ZONE_W - 1.2;
  const benches = [];
  departments.forEach(([dept, everyone]) => {
    if (dept === VO_WAREHOUSE_DEPT) return;
    const members = dept === VO_OFFICE_DEPT ? everyone.slice(VO_OFFICE_SEATS) : everyone;
    for (let start = 0; start < members.length; start += VO_MAX_PER_BENCH) {
      const group = members.slice(start, start + VO_MAX_PER_BENCH);
      // Up to six sit in one row facing the camera, so their faces show;
      // bigger teams fill both sides of the bench.
      const singleRow = group.length <= 6;
      const cols = singleRow ? Math.max(2, group.length) : Math.ceil(group.length / 2);
      const width = cols * VO_SEAT_W + 0.75; // table margins and the team wall
      const left = zones[0];
      const leftLast = left.rows[left.rows.length - 1];
      const leftFits = !(leftLast.used && leftLast.used + width > room) || left.rows.length < VO_LEFT_ROWS;
      const zone = leftFits ? left : zones[1];
      let row = zone.rows[zone.rows.length - 1];
      if (row.used && row.used + width > room) { row = { used: 0, blocks: [] }; zone.rows.push(row); }
      const r = zone.rows.length - 1;
      const x0 = zone.dir === -1 ? zone.edge - row.used - width : zone.edge + row.used;
      row.used += width + 0.9;
      const cz = zone.startZ + r * pitch + VO_ROW_D / 2;
      const bench = { dept, x0, x1: x0 + width, cz, cols, zone: zone.side };
      row.blocks.push(bench);
      benches.push(bench);
      group.forEach((person, i) => {
        const col = singleRow ? i : Math.floor(i / 2);
        const front = !singleRow && i % 2 === 1;
        // Seat 1 (the team lead, unless HR moved them) is next to the team wall.
        const x = x0 + 0.25 + (cols - 1 - col + 0.5) * VO_SEAT_W;
        const aisleZ = front ? cz + VO_ROW_D / 2 + VO_AISLE / 2 : cz - VO_ROW_D / 2 - VO_AISLE / 2;
        seats.push({
          person,
          x,
          z: front ? cz + 0.85 : cz - 0.85,
          deskZ: cz,
          face: front ? Math.PI : 0,
          stand: false,
          exit: [{ x, z: aisleZ }, { x: zone.spine, z: aisleZ, line: zone.side }],
        });
      });
    }
  });

  // Whatever each row leaves free on the wall side becomes booths, shelves
  // and plants.
  const fillers = [];
  const usedRows = (zone) => zone.rows.filter((row) => row.used).length;
  zones.forEach((zone) => zone.rows.forEach((row, r) => {
    if (!row.used && zone.side === 'R') return;
    const cz = zone.startZ + r * pitch + VO_ROW_D / 2;
    const free = room - (row.used ? row.used - 0.9 : 0) - 0.3;
    const count = Math.floor(free / 1.7);
    for (let k = 0; k < count; k += 1) {
      const offset = (row.used || 0) + 0.3 + k * 1.7 + 0.8;
      fillers.push({ x: zone.edge + zone.dir * offset, z: cz, kind: (r + k + (zone.side === 'R' ? 1 : 0)) % 3 });
    }
  }));

  const rows = Math.max(1, usedRows(zones[0]));
  const D = Math.max(
    zones[0].startZ + rows * pitch,
    usedRows(zones[1]) ? zones[1].startZ + usedRows(zones[1]) * pitch : 0,
    lounge.z1 + 0.6,
  ) + VO_FRONT_WALK;
  return {
    W, D, back, backAisle, xL, xR, spineL, spineR,
    frontZ: D - VO_FRONT_WALK / 2,
    cx: xL + VO_WALK_W / 2,
    seats, benches, fillers, rows, lounge,
    whStart, whCols, whUsedCols, pods,
  };
}

function voBuildScene() {
  const stage = document.getElementById('vo-stage');
  if (!stage) return;
  voDisposeScene();
  stage.innerHTML = '';

  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  renderer.setClearColor(dark ? '#1b2723' : '#d3e3da');
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Orthographic, for the clean isometric look of an office floor plan.
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 600);
  const hemi = new THREE.HemisphereLight('#ffffff', dark ? '#334155' : '#d9cdb8', 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff7ea', 0.38);
  sun.position.set(20, 30, 26);
  scene.add(sun);

  const s = {
    renderer, scene, camera, stage, dark, hemi, sun,
    chars: new Map(),
    monitors: new Map(),
    plates: new Map(),
    counters: new Map(),
    hoverId: null,
    seats: new Map(),
    breakSlots: [],
    door: null,
    frontZ: 0,
    orbit: { theta: Math.PI / 4, phi: 0.96, radius: 30, target: new THREE.Vector3() },
    home: null,
    focusTo: null,
    raf: 0,
    last: performance.now(),
    clock: 0,
    root: new THREE.Group(),
  };
  scene.add(s.root);
  voState.scene = s;

  voBuildFloor(s);
  voBindControls(s);

  s.onResize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', s.onResize);

  voSyncPeople(true);
  voApplyDaylight(s);
  const loop = (now) => {
    if (!renderer.domElement.isConnected) { voDisposeScene(); return; }
    const dt = Math.min(0.05, (now - s.last) / 1000);
    s.last = now;
    s.clock += dt;
    voTick(s, dt);
    voApplyOrbit(s);
    renderer.render(scene, camera);
    s.raf = requestAnimationFrame(loop);
  };
  s.raf = requestAnimationFrame(loop);
}

// The whole floor. Rebuilt whenever the roster changes shape (someone added,
// removed or moved department); otherwise kept.
function voBuildFloor(s) {
  const T = THREE;
  const root = s.root;
  while (root.children.length) root.remove(root.children[0]);
  s.monitors.clear();
  s.seats.clear();
  s.plates.clear();
  s.counters.clear();

  const departments = voDepartments(voState.people);
  s.rosterKey = departments.map(([d, m]) => `${d}:${m.map((p) => p.id).join(',')}`).join('|');
  const L = voLayout(departments);
  s.layout = L;
  s.frontZ = L.frontZ;
  const { W, D, back } = L;

  const kit = {
    unit: new T.BoxGeometry(1, 1, 1),
    cyl: new T.CylinderGeometry(0.5, 0.5, 1, 16),
    ball: new T.SphereGeometry(0.5, 12, 9),
    kraft: voMat(VO_KRAFT),
    tape: voMat('#e8d5a8'),
    metal: voMat(s.dark ? '#64748b' : '#94a3b8'),
    darkMetal: voMat('#475569'),
    frame: voMat(s.dark ? '#5e7470' : '#8fa8a3'),
    orange: voMat('#d9844a'),
    yellow: voMat('#e6c25a'),
    wood: voMat('#8b5a3c'),
    white: voMat('#f6efe2'),
    desk: voMat(s.dark ? '#b89c74' : '#e8d1aa'),
    deskLeg: voMat('#bfa27a'),
    partition: voMat(s.dark ? '#6f8784' : '#93aca7'),
    chair: voMat('#3d4850'),
    counter: voMat('#c39466'),
    skirting: voMat(s.dark ? '#6b6253' : '#e3d3b6'),
    pane: new T.MeshLambertMaterial({ color: '#f5ac83', emissive: '#f08a5a', emissiveIntensity: 0.15 }),
    paneLight: voMat('#fbcfae'),
    offWhite: voMat('#d9d1c2'),
    black: voMat('#1f2937'),
    concrete: voMat(s.dark ? '#3b3a36' : '#ddd7cc'),
    booth: voMat('#6f9e98'),
    boothSeat: voMat('#d9b25b'),
    sofa: voMat('#e3967b'),
    armchair: voMat('#b49fd4'),
    ottoman: voMat('#9fd0b0'),
    rug: voMat(s.dark ? '#4a5a55' : '#cfe3da'),
    folders: ['#d97a5a', '#6aa39a', '#e3b85c', '#8a7fbf', '#c95f5f'].map(voMat),
    mug: voMat('#f1f5f9'),
    leaf: voMat('#4a9466'),
    leafLight: voMat('#6db585'),
    pot: voMat('#b5723f'),
    potWhite: voMat(s.dark ? '#d6d3cc' : '#f4f1ea'),
    soil: voMat('#5b4636'),
    stem: voMat('#7c9a52'),
    frond: new T.MeshLambertMaterial({ map: voFrondTexture(), alphaTest: 0.45, side: T.DoubleSide }),
    frondGeo: voFrondGeometry(),
    glass: new T.MeshLambertMaterial({ color: '#e3f2ec', transparent: true, opacity: 0.3, depthWrite: false }),
    wall: voMat(s.dark ? '#a69d8c' : '#f6eddd'),
    wallEdge: voMat(s.dark ? '#8a826f' : '#e9dbc0'),
    glassDark: new T.MeshLambertMaterial({ color: '#1f2937', transparent: true, opacity: 0.22, depthWrite: false }),
    frameDark: voMat('#111827'),
  };
  s.kit = kit;

  // Floor slab: office tiles on top, a darker edge all round.
  const tiles = voTileTexture(s.dark);
  tiles.repeat.set(W / 2.4, D / 2.4);
  const edge = voMat(s.dark ? '#5b5040' : '#d8bf98');
  const slab = new T.Mesh(new T.BoxGeometry(W, 0.35, D),
    [edge, edge, new T.MeshLambertMaterial({ map: tiles }), edge, edge, edge]);
  slab.position.set(W / 2, -0.175, D / 2);
  root.add(slab);

  // Two tall walls, back and left, with a cap along the top.
  voBlock(root, kit, kit.wall, W + 0.35, VO_WALL_H, 0.35, W / 2 - 0.175, VO_WALL_H / 2, -0.175);
  voBlock(root, kit, kit.wall, 0.35, VO_WALL_H, D, -0.175, VO_WALL_H / 2, D / 2);
  voBlock(root, kit, kit.wallEdge, W + 0.37, 0.06, 0.37, W / 2 - 0.175, VO_WALL_H + 0.03, -0.175);
  voBlock(root, kit, kit.wallEdge, 0.37, 0.06, D, -0.175, VO_WALL_H + 0.03, D / 2);
  voBlock(root, kit, kit.skirting, W, 0.12, 0.03, W / 2, 0.06, 0.015);
  voBlock(root, kit, kit.skirting, 0.03, 0.12, D, 0.015, 0.06, D / 2);

  voMeetingRooms(root, L, kit);
  voLounge(s, root, L, kit);
  voWarehouseRoom(root, L, kit);

  // Benches, each with its team wall at the +x end — the end the camera sees.
  L.benches.forEach((bench) => voBench(root, bench, kit));
  L.seats.forEach((seat) => {
    const toChair = Math.sign(seat.z - seat.deskZ);
    if (seat.stand) voPackingTable(root, seat, toChair, kit);
    else if (seat.office) s.monitors.set(seat.person.id, voLaptop(root, seat, toChair, kit));
    else s.monitors.set(seat.person.id, voSeat(root, seat, toChair, kit));
    s.seats.set(seat.person.id, seat);
    seat.toChair = toChair;
  });
  L.fillers.forEach((f) => {
    if (f.kind === 0) voBooth(root, kit, f.x, f.z);
    else if (f.kind === 1) voBookshelf(root, kit, f.x, f.z);
    else voPlant(root, kit, f.x, f.z, 1.3);
  });

  // The left wall: a peach window beside each bench row, a whiteboard
  // between every other pair.
  for (let r = 0; r < L.rows; r += 1) {
    const cz = back + VO_AISLE + r * (VO_ROW_D + VO_AISLE) + VO_ROW_D / 2;
    voWindow(root, kit, cz);
    if (r % 2 === 1) voWhiteboard(root, kit, 0.03, 1.55, cz - (VO_ROW_D + VO_AISLE) / 2, Math.PI / 2, r);
  }
  voWindow(root, kit, D - 1.6);

  // The way in: an open front edge with a welcome mat and two plants.
  const mat = voTextTexture('YNT DIGITAL', { color: '#f6eddd', bg: '#2f4f45', size: 56 });
  const welcome = new T.Mesh(new T.PlaneGeometry(0.55 * mat.aspect, 0.55), new T.MeshBasicMaterial({ map: mat.texture, transparent: true }));
  welcome.rotation.x = -Math.PI / 2;
  welcome.position.set(L.cx, 0.01, D - 0.45);
  root.add(welcome);
  voPlant(root, kit, L.cx - 2.6, D - 0.5, 1.1);
  voPlant(root, kit, L.cx + 2.6, D - 0.5, 1.1);
  s.door = { x: L.cx, z: D + 0.4, face: 0, exit: [{ x: L.cx, z: L.frontZ, line: 'F' }] };

  // Home view: isometric from the front-right corner, framed to the floor.
  const aspect = (s.stage.clientWidth || 4) / (s.stage.clientHeight || 3);
  const home = { theta: Math.PI / 4, phi: 0.96, target: new T.Vector3(W / 2, 0, D / 2) };
  const cam = s.camera;
  const dir = new T.Vector3(Math.sin(home.phi) * Math.sin(home.theta), Math.cos(home.phi), Math.sin(home.phi) * Math.cos(home.theta));
  cam.position.copy(home.target).addScaledVector(dir, 150);
  cam.lookAt(home.target);
  cam.updateMatrixWorld();
  const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  [[0, 0, 0], [W, 0, 0], [0, 0, D], [W, 0, D], [0, VO_WALL_H, 0], [W, VO_WALL_H, 0], [0, VO_WALL_H, D]].forEach(([x, y, z]) => {
    const p = new T.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x);
    box.y0 = Math.min(box.y0, p.y); box.y1 = Math.max(box.y1, p.y);
  });
  const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  home.target.addScaledVector(right, (box.x0 + box.x1) / 2).addScaledVector(up, (box.y0 + box.y1) / 2);
  home.radius = Math.min(VO_MAX_VIEW, Math.max((box.y1 - box.y0), (box.x1 - box.x0) / aspect) * 1.06);
  s.home = home;
  if (!s.orbitSet) {
    Object.assign(s.orbit, { ...home, target: home.target.clone() });
    s.orbitSet = true;
  }

  // Characters live outside the floor's rebuild; re-attach them.
  s.chars.forEach((c) => root.add(c.group));
}

// One box, sized and placed, from the shared unit cube.
function voBlock(parent, kit, mat, w, h, d, x, y, z) {
  const mesh = new THREE.Mesh(kit.unit, mat);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function voCylinder(parent, kit, mat, rx, h, rz, x, y, z) {
  const mesh = new THREE.Mesh(kit.cyl, mat);
  mesh.scale.set(rx * 2, h, rz * 2);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

// Many parcel boxes in one draw call. Each entry is [x, y, z, w, h, d], with y
// the box's base.
function voParcels(parent, kit, boxes) {
  if (!boxes.length) return;
  const mesh = new THREE.InstancedMesh(kit.unit, kit.kraft, boxes.length);
  const tape = new THREE.InstancedMesh(kit.unit, kit.tape, boxes.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  boxes.forEach(([x, y, z, w, h, d], i) => {
    mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, y + h / 2, z), q, new THREE.Vector3(w, h, d)));
    // A strip of tape over the top, the thing that makes it read as a parcel.
    tape.setMatrixAt(i, m.compose(new THREE.Vector3(x, y + h + 0.005, z), q, new THREE.Vector3(w * 0.18, 0.012, d * 1.01)));
  });
  parent.add(mesh);
  parent.add(tape);
}

// A long light-wood bench table with a teal-grey cubicle divider down its
// middle, and the team's feature wall standing at its +x end.
function voBench(root, bench, kit) {
  const color = VO_DEPT_COLOR[bench.dept] || VO_DEPT_COLOR.Unassigned;
  const len = bench.cols * VO_SEAT_W + 0.2;
  const tx = bench.x0 + 0.15 + len / 2;
  voBlock(root, kit, kit.desk, len, 0.07, 1.05, tx, 0.74, bench.cz);
  for (let c = 0; c <= bench.cols; c += 2) {
    const lx = bench.x0 + 0.2 + Math.min(c * VO_SEAT_W, len - 0.1);
    voBlock(root, kit, kit.deskLeg, 0.05, 0.72, 0.95, lx, 0.36, bench.cz);
  }
  voBlock(root, kit, kit.partition, len - 0.1, 0.5, 0.05, tx, 1.02, bench.cz);

  const wallD = VO_ROW_D - 0.2;
  const wallH = 2.1;
  const face = new THREE.MeshLambertMaterial({ map: voTeamWallTexture(bench.dept, color, wallD / wallH) });
  const plain = voMat(color);
  const wall = new THREE.Mesh(kit.unit, [face, plain, plain, plain, plain, plain]);
  wall.scale.set(0.14, wallH, wallD);
  wall.position.set(bench.x1 - 0.12, wallH / 2, bench.cz);
  root.add(wall);
}

// A bench seat: dark chair, monitor (returned, it lights while someone works
// there), keyboard, a stack of files and a mug, picked from the person's id
// so a desk looks the same every day.
function voSeat(root, seat, toChair, kit) {
  const g = new THREE.Group();
  g.position.set(seat.x, 0, seat.deskZ);
  root.add(g);
  const monitor = new THREE.Mesh(kit.unit, new THREE.MeshLambertMaterial({ color: '#2e3b40', emissive: '#000000' }));
  monitor.scale.set(0.55, 0.34, 0.04);
  monitor.position.set(0, 1.02, toChair * 0.12);
  g.add(monitor);
  voBlock(g, kit, kit.black, 0.06, 0.12, 0.04, 0, 0.82, toChair * 0.14);
  voBlock(g, kit, kit.black, 0.42, 0.02, 0.13, 0, 0.78, toChair * 0.34);
  const h = voHash(seat.person.id);
  const side = h % 2 ? 1 : -1;
  for (let i = 0; i < 1 + (h % 3); i += 1) {
    const folder = voBlock(g, kit, kit.folders[(h + i) % kit.folders.length], 0.24, 0.025, 0.18, side * 0.42, 0.785 + i * 0.027, toChair * 0.3);
    folder.rotation.y = (((h >> i) % 5) - 2) * 0.1;
  }
  voCylinder(g, kit, kit.mug, 0.04, 0.1, 0.04, -side * 0.45, 0.82, toChair * 0.3);

  const chair = new THREE.Group();
  chair.position.set(seat.x, 0, seat.z);
  root.add(chair);
  voBlock(chair, kit, kit.chair, 0.46, 0.07, 0.44, 0, 0.46, 0);
  voBlock(chair, kit, kit.chair, 0.46, 0.44, 0.06, 0, 0.73, toChair * 0.21);
  voBlock(chair, kit, kit.darkMetal, 0.05, 0.42, 0.05, 0, 0.22, 0);
  voBlock(chair, kit, kit.darkMetal, 0.38, 0.03, 0.38, 0, 0.02, 0);
  return monitor;
}

// An areca palm in a white pot: a handful of thin stems fanning out of the
// soil, each ending in arching feathery fronds. Each plant is turned and
// sized a little differently, picked from where it stands.
function voPlant(root, kit, x, z, size = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(size);
  root.add(g);
  voCylinder(g, kit, kit.potWhite, 0.2, 0.46, 0.2, 0, 0.23, 0);
  voCylinder(g, kit, kit.potWhite, 0.225, 0.05, 0.225, 0, 0.46, 0);
  voCylinder(g, kit, kit.soil, 0.19, 0.02, 0.19, 0, 0.48, 0);
  const seed = voHash(`${x.toFixed(2)}:${z.toFixed(2)}`);
  const stems = 6;
  for (let i = 0; i < stems; i += 1) {
    const yaw = (i / stems) * Math.PI * 2 + (seed % 360) * (Math.PI / 180);
    const lean = 0.08 + ((seed >> i) % 4) * 0.04;
    const height = 0.95 + ((seed >> (i + 2)) % 5) * 0.12;
    // The stem, leaning out a little from the pot's centre.
    const stem = new THREE.Group();
    stem.position.set(0, 0.48, 0);
    stem.rotation.set(0, yaw, 0);
    g.add(stem);
    const tilt = new THREE.Group();
    tilt.rotation.x = lean;
    stem.add(tilt);
    voCylinder(tilt, kit, kit.stem, 0.012, height, 0.012, 0, height / 2, 0);
    // Two fronds off the top of each stem, arching outward and down.
    [0, 1].forEach((k) => {
      const frond = new THREE.Mesh(kit.frondGeo, kit.frond);
      frond.position.set(0, height * (0.78 + k * 0.22), 0);
      frond.rotation.set(0.3 + k * 0.3 + ((seed >> (i + k)) % 3) * 0.07, (k ? 0.5 : -0.4), 0, 'YXZ');
      frond.scale.setScalar(0.85 + ((seed >> (i * 2 + k)) % 4) * 0.08);
      tilt.add(frond);
    });
  }
}

// A purple phone booth, open to the front, with a yellow bench inside.
function voBooth(root, kit, x, z) {
  const w = 1.3;
  const d = 1.2;
  const h = 2.2;
  voBlock(root, kit, kit.booth, w, h, 0.08, x, h / 2, z - d / 2);
  voBlock(root, kit, kit.booth, 0.08, h, d, x - w / 2, h / 2, z);
  voBlock(root, kit, kit.booth, 0.08, h, d, x + w / 2, h / 2, z);
  voBlock(root, kit, kit.booth, w + 0.08, 0.08, d, x, h, z);
  voBlock(root, kit, kit.boothSeat, w - 0.2, 0.4, 0.45, x, 0.2, z - 0.3);
  voBlock(root, kit, kit.white, 0.5, 0.04, 0.35, x, 0.75, z + 0.1);
}

// A low open bookshelf of binders, facing the room.
function voBookshelf(root, kit, x, z) {
  const w = 1.4;
  const h = 1.3;
  voBlock(root, kit, kit.wood, 0.05, h, 0.4, x - w / 2, h / 2, z);
  voBlock(root, kit, kit.wood, 0.05, h, 0.4, x + w / 2, h / 2, z);
  for (let sh = 0; sh <= 3; sh += 1) {
    voBlock(root, kit, kit.wood, w, 0.04, 0.4, x, Math.min(sh * (h / 3), h - 0.02), z);
    if (sh === 3) break;
    for (let b = 0; b < 12; b += 1) {
      if ((sh * 5 + b) % 7 === 6) continue;
      const bh = 0.3;
      voBlock(root, kit, kit.folders[(b + sh) % kit.folders.length], 0.08, bh, 0.3, x - w / 2 + 0.12 + b * 0.105, sh * (h / 3) + 0.02 + bh / 2, z);
    }
  }
}

// A laptop on an office table (its screen is returned and lights while the
// person works there).
function voLaptop(root, seat, toChair, kit) {
  const z = seat.deskZ + toChair * 0.3;
  voBlock(root, kit, kit.metal, 0.34, 0.02, 0.24, seat.x, 0.79, z);
  const screen = new THREE.Mesh(kit.unit, new THREE.MeshLambertMaterial({ color: '#2e3b40', emissive: '#000000' }));
  screen.scale.set(0.34, 0.22, 0.015);
  screen.position.set(seat.x, 0.9, z - toChair * 0.12);
  screen.rotation.x = toChair * 0.25;
  root.add(screen);
  return screen;
}

// A whiteboard with a few marker scribbles.
function voWhiteboard(root, kit, x, y, z, rotY, seed = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = rotY;
  root.add(g);
  voBlock(g, kit, kit.frame, 1.9, 1.05, 0.04, 0, 0, 0.02);
  voBlock(g, kit, kit.white, 1.8, 0.95, 0.04, 0, 0, 0.04);
  for (let i = 0; i < 4; i += 1) {
    const w = 0.4 + ((seed * 7 + i * 3) % 5) * 0.2;
    voBlock(g, kit, kit.folders[(seed + i) % kit.folders.length], w, 0.04, 0.02, -0.75 + w / 2, 0.3 - i * 0.2, 0.07);
  }
}

// A peach-lit window set into the left wall, cream frame and sill.
function voWindow(root, kit, z) {
  const g = new THREE.Group();
  g.position.set(0.02, 1.6, z);
  g.rotation.y = Math.PI / 2;
  root.add(g);
  voBlock(g, kit, kit.white, 1.5, 1.2, 0.05, 0, 0, 0.02);
  voBlock(g, kit, kit.pane, 1.3, 1.0, 0.04, 0, 0, 0.05);
  voBlock(g, kit, kit.paneLight, 1.3, 0.12, 0.02, 0, 0.18, 0.075);
  voBlock(g, kit, kit.paneLight, 1.3, 0.06, 0.02, 0, -0.12, 0.075);
  voBlock(g, kit, kit.white, 0.05, 1.0, 0.03, 0, 0, 0.08);
  voBlock(g, kit, kit.white, 1.6, 0.06, 0.16, 0, -0.62, 0.08);
}

// Glass partition from (x0, z0) to (x1, z1) with a dark frame top and bottom.
function voGlass(root, kit, x0, z0, x1, z1, h = 2.3, finish = { glass: kit.glass, frame: kit.frame }) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const [w, d] = along ? [len, 0.05] : [0.05, len];
  voBlock(root, kit, finish.glass, w, h, d, cx, h / 2, cz);
  voBlock(root, kit, finish.frame, along ? len : 0.07, 0.06, along ? 0.07 : len, cx, h, cz);
  voBlock(root, kit, finish.frame, along ? len : 0.07, 0.05, along ? 0.07 : len, cx, 0.025, cz);
  const posts = Math.max(1, Math.round(len / 2));
  for (let i = 0; i <= posts; i += 1) {
    const t = i / posts;
    voBlock(root, kit, finish.frame, 0.06, h, 0.06, x0 + (x1 - x0) * t, h / 2, z0 + (z1 - z0) * t);
  }
}

// Management's two glass offices in the back-left corner: an oval table with
// six chairs, a whiteboard, a doorway at each room's right, and the team's
// name across the back wall.
function voMeetingRooms(root, L, kit) {
  const roomW = VO_ZONE_W / 2;
  [0, 1].forEach((i) => {
    voGlass(root, kit, roomW * i, L.back, roomW * (i + 1) - 1.3, L.back);
    voGlass(root, kit, roomW * (i + 1) - 0.3, L.back, roomW * (i + 1), L.back);
  });
  voGlass(root, kit, roomW, 0, roomW, L.back);
  voWallText(root, VO_OFFICE_DEPT.toUpperCase(), VO_DEPT_COLOR[VO_OFFICE_DEPT], 0.36, VO_ZONE_W / 2, 2.5, 0.02);
  voGlass(root, kit, VO_ZONE_W, 0, VO_ZONE_W, L.back);
  [0, 1].forEach((i) => {
    const cx = roomW * i + roomW / 2;
    const cz = L.back / 2 + 0.3;
    voCylinder(root, kit, kit.desk, 1.5, 0.07, 0.55, cx, 0.74, cz);
    voCylinder(root, kit, kit.darkMetal, 0.08, 0.72, 0.08, cx - 0.8, 0.36, cz);
    voCylinder(root, kit, kit.darkMetal, 0.08, 0.72, 0.08, cx + 0.8, 0.36, cz);
    [-1, 0, 1].forEach((k) => {
      [-1, 1].forEach((side) => {
        const chair = new THREE.Group();
        chair.position.set(cx + k * 0.9, 0, cz + side * 0.95);
        root.add(chair);
        voBlock(chair, kit, kit.offWhite, 0.42, 0.06, 0.42, 0, 0.46, 0);
        voBlock(chair, kit, kit.offWhite, 0.42, 0.4, 0.05, 0, 0.7, side * 0.2);
        voBlock(chair, kit, kit.darkMetal, 0.05, 0.42, 0.05, 0, 0.22, 0);
      });
    });
    voWhiteboard(root, kit, cx, 1.45, 0.03, 0, i + 2);
    voPlant(root, kit, roomW * i + 0.55, L.back - 0.6, 1.1);
  });
}

// The lounge, which is the break room: a room of black-framed glass under
// the warehouse, its doorway on the walkway side. A black panel holds the TV
// over the café counter and fridge; then high
// tables, a sofa and armchairs round a coffee table on a rug, and a table for
// four. Every seat in it is a break spot; past those, people stand.
function voLounge(s, root, L, kit) {
  const { x0, x1, z0, z1, side, spine } = L.lounge;
  const cx = (x0 + x1) / 2;
  const finish = { glass: kit.glassDark, frame: kit.frameDark };
  // The doorway faces the walkway; plants go on the far (outer) side.
  const innerX = side === 'L' ? x1 : x0;
  const inward = side === 'L' ? -1 : 1;
  const outerX = side === 'L' ? x0 + 0.6 : x1 - 0.6;
  const doorZ = z0 + VO_LOUNGE_D / 2;
  const doorIn = { x: innerX + inward * 0.7, z: doorZ };
  const slots = [];
  const spot = (x, z, face, sit) => slots.push({ x, z, face, sit, exit: [doorIn, { x: spine, z: doorZ, line: side }] });

  // Walls: black-framed glass all round, a gap for the doorway, and a solid
  // black panel behind the café for the TV.
  voGlass(root, kit, x0, z0, x1, z0, 2.3, finish);
  voBlock(root, kit, kit.frameDark, 4.8, 2.3, 0.1, cx - 2.2, 1.15, z0 + 0.06);
  voGlass(root, kit, x0, z1, x1, z1, 2.3, finish);
  voGlass(root, kit, innerX, z0, innerX, doorZ - 0.75, 2.3, finish);
  voGlass(root, kit, innerX, doorZ + 0.75, innerX, z1, 2.3, finish);
  voGlass(root, kit, side === 'L' ? x0 : x1, z0, side === 'L' ? x0 : x1, z1, 2.3, finish);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, VO_LOUNGE_D), kit.rug);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0.004, (z0 + z1) / 2);
  floor.material = voMat(s.dark ? '#3c4743' : '#e9f1ec');
  root.add(floor);

  // Café: counter and coffee machine under the TV, the fridge at the end.
  const cafeX = cx - 2.2;
  voTv(s, root, kit, cafeX, z0 + 0.12, 1.85);
  voBlock(root, kit, kit.counter, 4.0, 1.0, 0.8, cafeX, 0.5, z0 + 0.55);
  voBlock(root, kit, kit.desk, 4.1, 0.06, 0.85, cafeX, 1.02, z0 + 0.55);
  voBlock(root, kit, kit.black, 0.45, 0.55, 0.4, cafeX - 1.3, 1.32, z0 + 0.5);
  voBlock(root, kit, kit.metal, 0.35, 0.4, 0.35, cafeX + 1.1, 1.25, z0 + 0.5);
  voBlock(root, kit, voMat('#e4e7e6'), 0.8, 2.0, 0.75, cafeX + 2.6, 1.0, z0 + 0.55);
  voBlock(root, kit, kit.darkMetal, 0.04, 0.6, 0.04, cafeX + 2.3, 1.2, z0 + 0.94);
  [-1.2, -0.4, 0.4, 1.2].forEach((dx) => spot(cafeX + dx, z0 + 1.7, Math.PI, false));
  [cx + 1.8, cx + 4.0].forEach((tx) => {
    voCylinder(root, kit, kit.desk, 0.45, 0.05, 0.45, tx, 1.05, z0 + 2.1);
    voCylinder(root, kit, kit.darkMetal, 0.05, 1.0, 0.05, tx, 0.5, z0 + 2.1);
    [-0.75, 0.75].forEach((sx) => {
      voCylinder(root, kit, kit.ottoman, 0.2, 0.46, 0.2, tx + sx, 0.23, z0 + 2.1);
      spot(tx + sx, z0 + 2.1, sx < 0 ? Math.PI / 2 : -Math.PI / 2, true);
    });
  });

  // Planter of shrubs behind the sofa.
  voBlock(root, kit, kit.pot, 3.6, 0.45, 0.45, cx, 0.22, z0 + 3.15);
  for (let i = 0; i < 6; i += 1) {
    const ball = new THREE.Mesh(kit.ball, i % 2 ? kit.leafLight : kit.leaf);
    ball.scale.setScalar(0.5);
    ball.position.set(cx - 1.5 + i * 0.6, 0.6, z0 + 3.15);
    root.add(ball);
  }

  const rugZ = z0 + 5.4;
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.8, 40), kit.rug);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(cx, 0.01, rugZ);
  root.add(rug);
  // Sofa facing the room.
  voBlock(root, kit, kit.sofa, 3.1, 0.42, 0.9, cx, 0.21, z0 + 4.0);
  voBlock(root, kit, kit.sofa, 3.1, 0.55, 0.25, cx, 0.6, z0 + 3.65);
  voBlock(root, kit, kit.sofa, 0.25, 0.6, 0.9, cx - 1.55, 0.3, z0 + 4.0);
  voBlock(root, kit, kit.sofa, 0.25, 0.6, 0.9, cx + 1.55, 0.3, z0 + 4.0);
  [-1, 0, 1].forEach((k) => spot(cx + k * 0.95, z0 + 4.15, 0, true));
  voCylinder(root, kit, kit.desk, 0.65, 0.06, 0.65, cx, 0.42, rugZ);
  voCylinder(root, kit, kit.darkMetal, 0.06, 0.4, 0.06, cx, 0.2, rugZ);
  [-1, 1].forEach((dir) => {
    const ax = cx + dir * 2.05;
    voBlock(root, kit, kit.armchair, 0.85, 0.4, 0.85, ax, 0.2, rugZ);
    voBlock(root, kit, kit.armchair, 0.22, 0.5, 0.85, ax + dir * 0.32, 0.6, rugZ);
    spot(ax - dir * 0.05, rugZ, dir < 0 ? Math.PI / 2 : -Math.PI / 2, true);
    voCylinder(root, kit, kit.ottoman, 0.28, 0.36, 0.28, cx + dir * 0.85, 0.18, rugZ + 1.2);
    spot(cx + dir * 0.85, rugZ + 1.2, Math.PI, true);
  });

  // Table for four by the outer wall.
  const tx = side === 'L' ? x0 + 1.7 : x1 - 1.7;
  const tz = z1 - 1.4;
  voBlock(root, kit, kit.desk, 1.3, 0.07, 1.3, tx, 0.74, tz);
  voCylinder(root, kit, kit.darkMetal, 0.06, 0.72, 0.06, tx, 0.36, tz);
  [[-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2], [0, -1, 0], [0, 1, Math.PI]].forEach(([dx, dz, face]) => {
    const x = tx + dx * 0.95;
    const z = tz + dz * 0.95;
    voBlock(root, kit, kit.chair, 0.42, 0.07, 0.42, x, 0.46, z);
    voBlock(root, kit, kit.darkMetal, 0.05, 0.42, 0.05, x, 0.22, z);
    spot(x, z, face, true);
  });
  voPlant(root, kit, outerX, z0 + 2.9, 1.2);
  voPlant(root, kit, cx - inward * 3.4, z0 + 4.2, 1.1);
  voPlant(root, kit, cx + inward * 3.4, z0 + 4.2, 1.1);
  // More on break than there are seats: they stand about in front.
  for (let r = 0; r < 2; r += 1) {
    for (let k = 0; k < 6; k += 1) spot(cx - inward * 0.2 + inward * (k - 2.5) * 0.8, z1 - 1.6 + r * 0.8, Math.PI, false);
  }
  s.breakSlots = slots;

  // The walkway's own end of the back wall: a printer and a palm.
  voBlock(root, kit, kit.offWhite, 0.7, 0.75, 0.55, L.cx - 0.55, 0.375, 0.45);
  voBlock(root, kit, kit.black, 0.6, 0.05, 0.45, L.cx - 0.55, 0.78, 0.45);
  voPlant(root, kit, L.cx + 0.7, 0.55, 1.1);
}

// A packing table at a Logistics seat: tabletop, a parcel being packed, a tape
// dispenser and a short stack ready to go underneath.
function voPackingTable(root, seat, toChair, kit) {
  const table = new THREE.Group();
  voBlock(table, kit, kit.wood, VO_DESK_W - 0.15, 0.08, 0.75, 0, 0.86, 0);
  [[-0.7, -0.3], [0.7, -0.3], [-0.7, 0.3], [0.7, 0.3]].forEach(([lx, lz]) => {
    voBlock(table, kit, kit.darkMetal, 0.06, 0.82, 0.06, lx, 0.41, lz);
  });
  voBlock(table, kit, kit.darkMetal, VO_DESK_W - 0.25, 0.04, 0.6, 0, 0.25, 0);
  voBlock(table, kit, kit.orange, 0.12, 0.08, 0.06, -0.55, 0.94, toChair * 0.2);
  table.position.set(seat.x, 0, seat.deskZ);
  root.add(table);
  const h = voHash(seat.person.id);
  voParcels(root, kit, [
    [seat.x + 0.1, 0.9, seat.deskZ, 0.5, 0.32, 0.4],
    [seat.x + 0.55, 0.9, seat.deskZ - toChair * 0.1, 0.3, 0.2 + (h % 3) * 0.04, 0.28],
    [seat.x - 0.4, 0.27, seat.deskZ, 0.45, 0.3, 0.4],
  ]);
}

// The warehouse in the back-right corner, behind glass with a doorway on its
// lounge side: concrete floor, safety lines, pallet racks of parcels along
// the back wall, packing tables, loaded pallets and a forklift in whatever
// floor the tables leave.
function voWarehouseRoom(root, L, kit) {
  const T = THREE;
  const x0 = L.xR;
  const x1 = L.W;
  const concrete = new T.Mesh(new T.PlaneGeometry(x1 - x0, L.back), kit.concrete);
  concrete.rotation.x = -Math.PI / 2;
  concrete.position.set((x0 + x1) / 2, 0.006, L.back / 2);
  root.add(concrete);
  [1.3, L.back - 0.2].forEach((z) => {
    const line = new T.Mesh(new T.PlaneGeometry(x1 - x0 - 1.4, 0.08), kit.yellow);
    line.rotation.x = -Math.PI / 2;
    line.position.set((x0 + 1.4 + x1) / 2, 0.012, z);
    root.add(line);
  });
  voGlass(root, kit, x0, 0, x0, L.back);
  voGlass(root, kit, x0 + 1.4, L.back, x1, L.back);
  voGlass(root, kit, x1, 0, x1, L.back);
  voWallText(root, `${VO_WAREHOUSE_DEPT.toUpperCase()} · WAREHOUSE`, VO_DEPT_COLOR[VO_WAREHOUSE_DEPT], 0.42, (x0 + x1) / 2, 2.45, 0.02);

  // Pallet racks: orange uprights, steel beams, three levels of parcels.
  const rackZ = 0.6;
  const bay = 2.0;
  const parcels = [];
  for (let bx = x0 + 0.3; bx + bay <= x1 - 0.2; bx += bay) {
    [bx, bx + bay].forEach((ux) => {
      voBlock(root, kit, kit.orange, 0.08, 2.1, 0.08, ux, 1.05, rackZ - 0.4);
      voBlock(root, kit, kit.orange, 0.08, 2.1, 0.08, ux, 1.05, rackZ + 0.4);
    });
    [0.08, 0.75, 1.42].forEach((ly, level) => {
      voBlock(root, kit, kit.darkMetal, bay, 0.06, 0.88, bx + bay / 2, ly, rackZ);
      for (let k = 0; k < 3; k += 1) {
        const seed = voHash(`${bx}:${level}:${k}`);
        if (seed % 7 === 0) continue;
        const w = 0.45 + (seed % 3) * 0.07;
        const h = 0.3 + (seed % 4) * 0.06;
        parcels.push([bx + 0.35 + k * 0.65, ly + 0.03, rackZ + ((seed % 3) - 1) * 0.08, w, h, 0.6]);
      }
    });
  }

  // Loaded pallets and a forklift where the packing tables stop.
  const open0 = L.whStart + L.whUsedCols * VO_DESK_W + 0.5;
  const space = x1 - 0.4 - open0;
  if (space >= 1.4) {
    [[open0 + 0.6, 2.5], [open0 + 0.6, 3.9]].concat(space >= 2.9 ? [[open0 + 2.0, 3.9]] : []).forEach(([px, pz], n) => {
      voBlock(root, kit, kit.wood, 1.1, 0.12, 1.1, px, 0.06, pz);
      for (let k = 0; k < 4; k += 1) {
        for (let l = 0; l < 1 + ((n + k) % 3); l += 1) {
          parcels.push([px + (k % 2 ? 0.26 : -0.26), 0.12 + l * 0.34, pz + (k < 2 ? 0.26 : -0.26), 0.48, 0.34, 0.48]);
        }
      }
    });
  }
  voParcels(root, kit, parcels);
  if (space >= 4.4) {
    const lift = new T.Group();
    voBlock(lift, kit, kit.yellow, 0.9, 0.55, 1.3, 0, 0.45, 0);
    voBlock(lift, kit, kit.black, 0.85, 0.08, 0.5, 0, 0.78, 0.25);
    voBlock(lift, kit, kit.darkMetal, 0.06, 1.1, 0.06, -0.35, 1.2, 0.05);
    voBlock(lift, kit, kit.darkMetal, 0.06, 1.1, 0.06, 0.35, 1.2, 0.05);
    voBlock(lift, kit, kit.darkMetal, 0.8, 0.05, 0.8, 0, 1.75, 0.35);
    voBlock(lift, kit, kit.darkMetal, 0.08, 1.8, 0.1, -0.22, 0.9, -0.72);
    voBlock(lift, kit, kit.darkMetal, 0.08, 1.8, 0.1, 0.22, 0.9, -0.72);
    voBlock(lift, kit, kit.metal, 0.08, 0.05, 0.75, -0.18, 0.12, -1.12);
    voBlock(lift, kit, kit.metal, 0.08, 0.05, 0.75, 0.18, 0.12, -1.12);
    [[-0.47, 0.4], [0.47, 0.4], [-0.47, -0.4], [0.47, -0.4]].forEach(([wx, wz]) => {
      const wheel = new T.Mesh(kit.cyl, kit.black);
      wheel.scale.set(0.36, 0.14, 0.36);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.18, wz);
      lift.add(wheel);
    });
    lift.position.set(x1 - 1.2, 0, 3.4);
    lift.rotation.y = 0.5;
    root.add(lift);
  }
}

// Shapes every character shares (built once), and materials cached by colour,
// so a full floor of people stays cheap.
const voCharParts = { geo: null, mats: new Map() };

function voCharGeo() {
  if (voCharParts.geo) return voCharParts.geo;
  const T = THREE;
  voCharParts.geo = {
    torso: new T.CapsuleGeometry(0.19, 0.28, 6, 16),
    hips: new T.CylinderGeometry(0.17, 0.18, 0.16, 16),
    limb: new T.CapsuleGeometry(0.064, 0.2, 4, 10),
    arm: new T.CapsuleGeometry(0.056, 0.24, 4, 10),
    hand: new T.SphereGeometry(0.058, 10, 8),
    dome: new T.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    neck: new T.CylinderGeometry(0.06, 0.07, 0.12, 10),
    head: new T.SphereGeometry(0.2, 22, 16),
    ear: new T.SphereGeometry(0.042, 8, 6),
    nose: new T.SphereGeometry(0.03, 8, 6),
    eye: new T.SphereGeometry(0.036, 12, 8),
    pupil: new T.SphereGeometry(0.021, 8, 6),
    smile: new T.TorusGeometry(0.05, 0.011, 6, 12, Math.PI),
    band: new T.TorusGeometry(0.215, 0.018, 6, 20, Math.PI),
    lens: new T.TorusGeometry(0.042, 0.009, 6, 16),
    hairCap: new T.SphereGeometry(0.216, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
    skirt: new T.CylinderGeometry(0.17, 0.27, 0.32, 18),
    ball: new T.SphereGeometry(0.5, 12, 9),
    box: new T.BoxGeometry(1, 1, 1),
    cyl: new T.CylinderGeometry(0.5, 0.5, 1, 14),
  };
  return voCharParts.geo;
}

function voCharMat(color) {
  if (!voCharParts.mats.has(color)) voCharParts.mats.set(color, new THREE.MeshLambertMaterial({ color }));
  return voCharParts.mats.get(color);
}

const VO_PANTS = ['#3d4a5c', '#4a4f57', '#7a6a58', '#2f3a40', '#5b5148', '#44525a'];
const VO_SHOES = ['#111827', '#7c2d12', '#f8fafc', '#374151'];
// Departments that live on the phone wear headsets.
const VO_HEADSET_DEPTS = ['CSR', 'RMO'];

// A cartoon person, built facing +z: bendable legs and arms, a face with
// eyes that blink, a hairstyle, an ID badge in the team colour,
// and the kit of their job — a headset on the phones, a blazer and tie in
// Management, a hard hat and hi-vis vest in Logistics, a clipboard in HR.
// The look is picked from the person's id, so it is the same every day.
// HR sets each person's avatar to male or female (see voSetAvatar): female
// picks long hair, a bun or a ponytail, lashes, earrings and sometimes a
// skirt; male short, curly or side-parted hair, broader shoulders and
// sometimes a beard. Unset stays neutral: short or curly hair, no extras.
function voMakeCharacter(person) {
  const T = THREE;
  const G = voCharGeo();
  const M = voCharMat;
  const h = voHash(person.id);
  const dept = employeeDepartment(person);
  const team = VO_DEPT_COLOR[dept] || VO_DEPT_COLOR.Unassigned;
  const skin = M(VO_SKIN[h % VO_SKIN.length]);
  const hair = M(VO_HAIR[(h >> 3) % VO_HAIR.length]);
  const pants = M(VO_PANTS[(h >> 5) % VO_PANTS.length]);
  const shoes = M(VO_SHOES[(h >> 7) % VO_SHOES.length]);
  const dark = M('#111827');
  const white = M('#ffffff');
  const isManagement = dept === 'Management';
  const isLogistics = dept === VO_WAREHOUSE_DEPT;
  const look = person.avatar_gender === 'male' || person.avatar_gender === 'female' ? person.avatar_gender : null;
  const top = M(isManagement ? '#1e293b' : isLogistics ? '#facc15' : team);
  const sleeve = M(isManagement ? '#1e293b' : team);
  const add = (parent, geo, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const mesh = new T.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  };

  const group = new T.Group();
  const body = new T.Group();
  group.add(body);

  // Legs: hip → thigh → knee → shin → shoe.
  const legs = [-1, 1].map((side) => {
    const hip = new T.Group();
    hip.position.set(side * 0.09, 0.6, 0);
    body.add(hip);
    add(hip, G.limb, pants, 0, -0.15, 0);
    const knee = new T.Group();
    knee.position.set(0, -0.29, 0);
    hip.add(knee);
    add(knee, G.limb, pants, 0, -0.14, 0);
    add(knee, G.dome, shoes, 0, -0.3, 0.035, 0.15, 0.13, 0.25);
    return { hip, knee };
  });

  // Hips, belt and buckle.
  add(body, G.hips, pants, 0, 0.64, 0, 1, 1, 0.8);
  add(body, G.box, dark, 0, 0.72, 0, 0.36, 0.04, 0.29);
  add(body, G.box, M('#d4d4d8'), 0, 0.72, 0.147, 0.06, 0.035, 0.01);

  // Torso, with a white collar at the neck.
  const build = look === 'female' ? 0.93 : look === 'male' ? 1.06 : 1;
  add(body, G.torso, top, 0, 0.98, 0, build, 1, 0.78);
  if (look === 'female' && !isLogistics && (h >> 13) % 2 === 0) {
    // Skirt over the hips, in the trousers' colour.
    add(body, G.skirt, pants, 0, 0.53, 0, 1, 1, 0.85);
  }
  [-1, 1].forEach((side) => {
    const collar = add(body, G.box, white, side * 0.055, 1.29, 0.11, 0.09, 0.035, 0.03);
    collar.rotation.z = side * -0.5;
  });
  if (isManagement) {
    // Blazer: a white shirt front and a tie in the team colour.
    add(body, G.box, white, 0, 1.15, 0.146, 0.1, 0.26, 0.01);
    add(body, G.box, M(team), 0, 1.12, 0.153, 0.04, 0.22, 0.012);
    add(body, G.box, M(team), 0, 1.245, 0.153, 0.06, 0.04, 0.014);
  } else if (isLogistics) {
    // Hi-vis vest: two reflective bands round the middle.
    [0.92, 1.06].forEach((y) => add(body, G.cyl, M('#e5e7eb'), 0, y, 0, 0.4, 0.035, 0.31));
  }
  if (!isManagement) {
    // ID lanyard and badge, the badge topped with the team colour.
    [-1, 1].forEach((side) => {
      const strap = add(body, G.box, M(team), side * 0.045, 1.2, 0.143, 0.018, 0.17, 0.01);
      strap.rotation.z = side * 0.42;
    });
    add(body, G.box, white, 0, 1.06, 0.152, 0.085, 0.11, 0.01);
    add(body, G.box, M(team), 0, 1.1, 0.158, 0.085, 0.03, 0.01);
  }

  // Arms: shoulder → sleeve → hand.
  const arms = [-1, 1].map((side) => {
    const shoulder = new T.Group();
    shoulder.position.set(side * 0.255 * build, 1.24, 0);
    shoulder.rotation.z = side * 0.07;
    body.add(shoulder);
    add(shoulder, G.arm, sleeve, 0, -0.17, 0);
    add(shoulder, G.hand, skin, 0, -0.38, 0);
    return shoulder;
  });
  if (dept === 'Human Resources') {
    // Clipboard in the left hand.
    const board = add(arms[0], G.box, M('#a16207'), 0.02, -0.38, 0.09, 0.17, 0.23, 0.015);
    board.rotation.x = -0.25;
    const paper = add(arms[0], G.box, white, 0.02, -0.39, 0.098, 0.14, 0.18, 0.01);
    paper.rotation.x = -0.25;
  }

  // Head.
  add(body, G.neck, skin, 0, 1.36, 0);
  const head = new T.Group();
  head.position.set(0, 1.55, 0);
  body.add(head);
  add(head, G.head, skin, 0, 0, 0);
  [-1, 1].forEach((side) => add(head, G.ear, skin, side * 0.2, -0.01, 0, 0.6, 1, 1));
  add(head, G.nose, skin, 0, -0.025, 0.2);
  const eyes = new T.Group();
  head.add(eyes);
  [-1, 1].forEach((side) => {
    add(eyes, G.eye, white, side * 0.075, 0.03, 0.168, 1, 1.15, 0.6);
    add(eyes, G.pupil, dark, side * 0.075, 0.025, 0.19);
  });
  const smile = add(head, G.smile, M(look === 'female' ? '#b4505a' : '#8a3b3b'), 0, -0.085, 0.172);
  smile.rotation.set(-0.35, 0, Math.PI);
  if (look === 'female') {
    // Lashes and small gold earrings.
    [-1, 1].forEach((side) => {
      const lash = add(head, G.box, dark, side * 0.08, 0.075, 0.178, 0.065, 0.012, 0.01);
      lash.rotation.z = side * -0.25;
      add(head, G.ball, M('#d4a017'), side * 0.2, -0.07, 0.01, 0.028, 0.028, 0.028);
    });
  }
  if ((h >> 11) % 4 === 0) {
    // Glasses.
    [-1, 1].forEach((side) => add(head, G.lens, dark, side * 0.075, 0.03, 0.2));
    add(head, G.box, dark, 0, 0.035, 0.205, 0.06, 0.012, 0.01);
  }

  if (isLogistics) {
    // Hard hat with a brim instead of hair showing.
    add(head, G.hairCap, M('#facc15'), 0, 0.04, 0, 1.08, 1.05, 1.08);
    add(head, G.cyl, M('#facc15'), 0, 0.05, 0.02, 0.5, 0.025, 0.52);
  } else {
    // 0 short · 1 long · 2 bun · 3 curls · 4 ponytail · 5 side part
    const styles = look === 'female' ? [1, 2, 4] : look === 'male' ? [0, 3, 5] : [0, 3];
    const style = styles[(h >> 9) % styles.length];
    const cap = add(head, G.hairCap, hair, 0, 0.025, -0.012);
    cap.rotation.x = -0.22;
    if (style === 1) {
      // Long hair down the back.
      add(head, G.box, hair, 0, -0.14, -0.1, 0.38, 0.36, 0.16);
      [-1, 1].forEach((side) => add(head, G.box, hair, side * 0.17, -0.1, 0.02, 0.06, 0.3, 0.16));
    } else if (style === 2) {
      // Bun.
      add(head, G.ball, hair, 0, 0.19, -0.13, 0.17, 0.17, 0.17);
    } else if (style === 3) {
      // Curls.
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * Math.PI * 2;
        add(head, G.ball, hair, Math.cos(a) * 0.15, 0.15, Math.sin(a) * 0.15 - 0.02, 0.12, 0.12, 0.12);
      }
    } else if (style === 4) {
      voPonytail(head, G, hair, add);
    } else if (style === 5) {
      // Side part: a swept fringe.
      const fringe = add(head, G.box, hair, -0.06, 0.14, 0.14, 0.2, 0.06, 0.1);
      fringe.rotation.z = 0.3;
    }
    if (look === 'male' && (h >> 13) % 3 === 0) {
      // Beard, with the smile brought out in front of it.
      add(head, G.ball, hair, 0, -0.12, 0.07, 0.3, 0.17, 0.23);
      smile.position.set(0, -0.075, 0.195);
    }
  }
  if (isLogistics && look === 'female') voPonytail(head, G, hair, add);
  if (VO_HEADSET_DEPTS.includes(dept)) {
    // Headset: band over the top, ear cups, a mic boom to the mouth.
    add(head, G.band, dark, 0, 0.02, 0);
    [-1, 1].forEach((side) => {
      const cup = add(head, G.cyl, dark, side * 0.215, -0.01, 0, 0.11, 0.05, 0.11);
      cup.rotation.z = Math.PI / 2;
    });
    const boom = add(head, G.box, dark, -0.15, -0.09, 0.12, 0.015, 0.015, 0.17);
    boom.rotation.y = 0.75;
    add(head, G.ball, dark, -0.07, -0.1, 0.19, 0.035, 0.035, 0.035);
  }

  const label = voNameSprite(person.name, person.status);
  label.position.y = 2.0;
  group.add(label);

  return {
    look, group, body, legs, arms, head, eyes, label,
    path: [], status: null, face: 0, leaving: false,
    walkT: h % 7, blinkAt: 1 + (h % 40) / 10, blinkTill: 0,
  };
}

function voPonytail(head, G, hair, add) {
  add(head, G.ball, hair, 0, 0.04, -0.2, 0.15, 0.15, 0.15);
  const tail = add(head, G.box, hair, 0, -0.11, -0.25, 0.1, 0.26, 0.1);
  tail.rotation.x = 0.3;
}

// The pose for this frame: walking swings arms against legs and bends the
// knees; seated folds hips and knees (typing at a desk, relaxed in the
// lounge); standing packs parcels at a warehouse table or idles.
function voPose(c, s, dt, moving) {
  const [l, r] = c.legs;
  const kind = c.rest?.kind;
  const sitting = !moving && c.rest?.sit;
  if (moving) {
    c.walkT += dt * 9;
    const swing = Math.sin(c.walkT) * 0.55;
    l.hip.rotation.x = swing;
    r.hip.rotation.x = -swing;
    l.knee.rotation.x = Math.max(0, Math.sin(c.walkT + Math.PI / 2)) * 0.8;
    r.knee.rotation.x = Math.max(0, Math.sin(c.walkT - Math.PI / 2)) * 0.8;
    c.arms[0].rotation.x = -swing * 0.8;
    c.arms[1].rotation.x = swing * 0.8;
    c.body.position.y = Math.abs(Math.sin(c.walkT)) * 0.04;
  } else if (sitting) {
    l.hip.rotation.x = -1.5;
    r.hip.rotation.x = -1.5;
    l.knee.rotation.x = 1.5;
    r.knee.rotation.x = 1.5;
    c.body.position.y = -0.13;
    if (kind === 'desk') {
      c.arms.forEach((arm, i) => { arm.rotation.x = -1.15 + Math.sin(s.clock * 13 + i * 2) * 0.05; });
    } else {
      c.arms.forEach((arm) => { arm.rotation.x = -0.35; });
    }
  } else {
    l.hip.rotation.x = 0;
    r.hip.rotation.x = 0;
    l.knee.rotation.x = 0;
    r.knee.rotation.x = 0;
    c.body.position.y = 0;
    if (kind === 'pack') {
      c.arms.forEach((arm, i) => { arm.rotation.x = -0.95 + Math.sin(s.clock * 4 + i * Math.PI) * 0.22; });
    } else {
      c.arms.forEach((arm, i) => { arm.rotation.x = Math.sin(s.clock * 1.5 + c.walkT + i) * 0.05; });
    }
  }
  // Look about a little while still; blink every few seconds.
  c.head.rotation.y = moving ? 0 : Math.sin(s.clock * 0.6 + c.walkT) * 0.18;
  if (s.clock > c.blinkAt) {
    c.blinkTill = s.clock + 0.12;
    c.blinkAt = s.clock + 2.5 + ((c.walkT * 1000) % 30) / 10;
  }
  c.eyes.scale.y = s.clock < c.blinkTill ? 0.15 : 1;
}

// Where a status sends someone, as a resting point with its way out.
function voDestination(s, person, slotIndex) {
  if (person.status === 'working') {
    const seat = s.seats.get(person.id);
    if (seat) return { x: seat.x, z: seat.z, face: seat.face, exit: seat.exit, sit: !seat.stand, kind: seat.stand ? 'pack' : 'desk' };
  }
  if (person.status === 'lunch' || person.status === 'break') {
    const slot = s.breakSlots[slotIndex % s.breakSlots.length];
    return { x: slot.x, z: slot.z, face: slot.face, exit: slot.exit, sit: slot.sit, kind: slot.sit ? 'lounge' : 'stand' };
  }
  return { ...s.door, sit: false, kind: 'stand' };
}

// A walk from one resting point to another: out along the first's exits to a
// walkway, across (a walkway to the same spine is straight; anything else
// goes via the front walkway), and in along the second's exits in reverse.
function voRoute(from, to, frontZ) {
  const out = [...(from.exit || [])];
  const inbound = [...(to.exit || [])].reverse();
  const a = out[out.length - 1] || from;
  const b = inbound[0] || to;
  if (!(a.line && a.line === b.line && a.line !== 'F')) out.push({ x: a.x, z: frontZ }, { x: b.x, z: frontZ });
  return [...out, ...inbound, { x: to.x, z: to.z }];
}

function voSyncPeople(initial = false) {
  const s = voState.scene;
  if (!s) return;
  const view = voView();
  const departments = voDepartments(voState.people);
  const rosterKey = departments.map(([d, m]) => `${d}:${m.map((p) => p.id).join(',')}`).join('|');
  // A new floor moves desks, so everyone already inside walks to the new spot.
  const rebuilt = rosterKey !== s.rosterKey;
  if (rebuilt) voBuildFloor(s);

  const msg = document.getElementById('vo-stage-msg');
  if (msg) msg.remove();

  // Break spots stick: whoever already holds one keeps it, so a person coming
  // back from break never makes the others shuffle seats.
  const onBreakNow = (p) => p.status === 'lunch' || p.status === 'break';
  const slotOf = new Map();
  const taken = new Set();
  view.forEach((p) => {
    const c = s.chars.get(p.id);
    if (onBreakNow(p) && c && onBreakNow(c) && Number.isInteger(c.slot) && !taken.has(c.slot)) {
      slotOf.set(p.id, c.slot);
      taken.add(c.slot);
    }
  });
  let nextFree = 0;
  view.forEach((p) => {
    if (!onBreakNow(p) || slotOf.has(p.id)) return;
    while (taken.has(nextFree)) nextFree += 1;
    slotOf.set(p.id, nextFree);
    taken.add(nextFree);
  });

  const inside = new Set();
  view.forEach((person) => {
    voSyncPlate(s, person);
    voSyncCounter(s, person);
    const onBreak = onBreakNow(person);
    const slotIndex = onBreak ? slotOf.get(person.id) : null;
    const present = ['working', 'lunch', 'break'].includes(person.status);
    let c = s.chars.get(person.id);
    if (c && c.look !== (person.avatar_gender || null)) {
      // HR changed this person's look: a new character takes the old one's
      // place, mid-walk and all.
      const next = voMakeCharacter(person);
      next.group.position.copy(c.group.position);
      next.group.rotation.y = c.group.rotation.y;
      Object.assign(next, { path: c.path, rest: c.rest, status: c.status, slot: c.slot, leaving: c.leaving, face: c.face });
      s.root.remove(c.group);
      s.root.add(next.group);
      s.chars.set(person.id, next);
      c = next;
    }
    const monitor = s.monitors.get(person.id);
    if (monitor) monitor.material.emissive.set(person.status === 'working' ? '#3f9f92' : '#000000');

    if (!present) {
      // Timed out while we watched: walk out the front, then go.
      if (c && !c.leaving) {
        const dest = voDestination(s, person, null);
        c.path = voRoute(c.rest || dest, dest, s.frontZ);
        c.leaving = true;
        c.rest = dest;
        voSetLabel(c, person);
      }
      return;
    }
    inside.add(person.id);
    const dest = voDestination(s, person, slotIndex);
    if (!c) {
      c = voMakeCharacter(person);
      s.chars.set(person.id, c);
      s.root.add(c.group);
      voSetLabel(c, person);
      if (initial) {
        // First paint: everyone already where they belong, no parade.
        c.group.position.set(dest.x, 0, dest.z);
        c.face = dest.face;
        c.path = [];
      } else {
        // Just timed in: walk in from the front.
        c.group.position.set(s.door.x, 0, s.door.z);
        c.path = voRoute(s.door, dest, s.frontZ);
      }
      c.status = person.status;
      c.rest = dest;
      c.slot = slotIndex;
      return;
    }
    if (rebuilt || c.status !== person.status || (onBreak && c.slot !== slotIndex) || c.leaving) {
      c.path = voRoute(c.rest || dest, dest, s.frontZ);
      c.leaving = false;
      c.status = person.status;
      c.rest = dest;
      c.slot = slotIndex;
    }
    voSetLabel(c, person);
  });
  voDrawTv(s, view);
  voApplyDaylight(s);
  // Accounts deactivated or gone from the roster lose their character outright.
  s.chars.forEach((c, id) => {
    if (!inside.has(id) && !c.leaving) { s.root.remove(c.group); s.chars.delete(id); }
  });
}

// Rebuilt only when what it says changes: status, or its note.
function voSetLabel(c, person) {
  const { note, tone } = voTagNote(person);
  const key = `${person.name}|${person.status}|${note}|${tone}`;
  if (c.labelKey === key) return;
  c.labelKey = key;
  c.alert = tone === 'alert';
  c.group.remove(c.label);
  c.label.material.map.dispose();
  c.label.material.dispose();
  c.label = voNameSprite(person.name, person.status, note, tone);
  c.label.position.y = 2.0;
  c.group.add(c.label);
}

function voTick(s, dt) {
  // Name tags keep one size on screen: a share of the current view height.
  const tag = s.orbit.radius * 0.036;
  const detail = s.orbit.radius < VO_DETAIL_VIEW;
  s.plates.forEach((plate) => {
    plate.sprite.scale.set(tag * 0.8 * plate.aspect, tag * 0.8, 1);
    plate.sprite.visible = plate.shown && (detail || plate.alert);
  });
  s.counters.forEach((counter, id) => {
    counter.sprite.scale.set(tag * 0.75 * counter.aspect, tag * 0.75, 1);
    counter.sprite.visible = counter.shown && (detail || id === s.hoverId || id === voState.focusId);
  });
  s.chars.forEach((c, id) => {
    c.label.scale.set(tag * c.label.userData.aspect, tag, 1);
    c.label.visible = detail || c.alert || id === s.hoverId || id === voState.focusId;
    const pos = c.group.position;
    let moving = false;
    let budget = VO_WALK_SPEED * dt;
    while (budget > 0 && c.path.length) {
      const next = c.path[0];
      const dx = next.x - pos.x;
      const dz = next.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-3) { c.path.shift(); continue; }
      const step = Math.min(dist, budget);
      pos.x += (dx / dist) * step;
      pos.z += (dz / dist) * step;
      c.face = Math.atan2(dx, dz);
      budget -= step;
      moving = true;
      if (step >= dist) c.path.shift();
    }
    if (!c.path.length && c.leaving) {
      s.root.remove(c.group);
      s.chars.delete(id);
      return;
    }
    if (!moving && c.rest) c.face = c.rest.face;
    // Turn smoothly toward where they are heading.
    let diff = c.face - c.group.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    c.group.rotation.y += diff * Math.min(1, dt * 10);

    voPose(c, s, dt, moving);
  });

  // Ease the camera toward a person someone clicked in the list.
  if (s.focusTo) {
    const c = s.chars.get(s.focusTo);
    if (!c) s.focusTo = null;
    else {
      const k = Math.min(1, dt * 3);
      s.orbit.target.lerp(new THREE.Vector3(c.group.position.x, 0.8, c.group.position.z), k);
      s.orbit.radius += (10 - s.orbit.radius) * k;
    }
  }
}

// orbit.radius is the height of the view in floor units (orthographic zoom).
function voApplyOrbit(s) {
  const o = s.orbit;
  const { camera, stage } = s;
  const aspect = (stage.clientWidth || 4) / (stage.clientHeight || 3);
  camera.left = (-o.radius * aspect) / 2;
  camera.right = (o.radius * aspect) / 2;
  camera.top = o.radius / 2;
  camera.bottom = -o.radius / 2;
  camera.updateProjectionMatrix();
  camera.position.set(
    o.target.x + 150 * Math.sin(o.phi) * Math.sin(o.theta),
    o.target.y + 150 * Math.cos(o.phi),
    o.target.z + 150 * Math.sin(o.phi) * Math.cos(o.theta),
  );
  camera.lookAt(o.target);
}

// Drag to turn, wheel or pinch to zoom, right drag (or shift drag) to pan.
function voBindControls(s) {
  const el = s.renderer.domElement;
  const o = s.orbit;
  const pointers = new Map();
  let pinch = 0;
  let panning = false;
  const clampView = (v) => Math.min(VO_MAX_VIEW, Math.max(5, v));
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  let press = null;
  let hoverAt = 0;
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    press = pointers.size === 1 ? { x: e.clientX, y: e.clientY } : null;
    panning = e.button === 2 || e.shiftKey;
    s.focusTo = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  el.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      // Not dragging: who is under the cursor (checked a few times a second).
      if (e.pointerType === 'mouse' && performance.now() - hoverAt > 90) {
        hoverAt = performance.now();
        s.hoverId = voPick(s, e);
        el.style.cursor = s.hoverId ? 'pointer' : '';
      }
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) o.radius = clampView(o.radius * (pinch / d));
      pinch = d;
      return;
    }
    if (panning) {
      const scale = o.radius / (s.stage.clientHeight || 600);
      const cos = Math.cos(o.theta);
      const sin = Math.sin(o.theta);
      o.target.x -= (dx * cos + dy * sin / Math.cos(o.phi)) * scale;
      o.target.z -= (-dx * sin + dy * cos / Math.cos(o.phi)) * scale;
      return;
    }
    o.theta -= dx * 0.006;
    o.phi = Math.min(1.3, Math.max(0.35, o.phi - dy * 0.005));
  });
  const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
  el.addEventListener('pointerup', (e) => {
    // A press that did not drag is a click: open whoever was clicked.
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) {
      const id = voPick(s, e);
      if (id) voOpenCard(id);
    }
    press = null;
    end(e);
  });
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    s.focusTo = null;
    o.radius = clampView(o.radius * (1 + Math.sign(e.deltaY) * 0.1));
  }, { passive: false });
}

// HR picks a person's character look. Shown at once; put back if the save
// fails.
async function voSetAvatar(id, gender) {
  const person = voState.people.find((p) => Number(p.id) === Number(id));
  if (!person) return;
  const before = person.avatar_gender || null;
  const apply = (value) => {
    person.avatar_gender = value;
    voRenderSide();
    voRenderCard();
    if (voState.scene) voSyncPeople();
  };
  apply(gender || null);
  try {
    await authorizedJsonRequest(`/virtual-office/avatar/${Number(id)}`, { method: 'PUT', body: JSON.stringify({ gender: gender || null }) });
  } catch (error) {
    apply(before);
    showToast('error', 'Avatar not saved', error.message || 'Try again.');
  }
}

function voFocus(id) {
  const s = voState.scene;
  voState.focusId = id;
  if (s && s.chars.has(id)) s.focusTo = id;
  voOpenCard(id);
}

function voResetView() {
  const s = voState.scene;
  voState.focusId = null;
  voCloseCard();
  if (s && s.home) {
    s.focusTo = null;
    Object.assign(s.orbit, { ...s.home, target: s.home.target.clone() });
  }
  voRenderSide();
}

/* ─── FLOOR EXTRAS: TV, desk plates, work counters ─────────────── */

// The lounge TV on the café wall: floor-wide numbers, redrawn each poll.
function voTv(s, root, kit, cx, z = 0, y = 2.12) {
  voBlock(root, kit, kit.black, 2.7, 1.05, 0.06, cx, y, z + 0.04);
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 288;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 0.96), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.set(cx, y, z + 0.075);
  root.add(screen);
  s.tv = { canvas, texture };
}

function voDrawTv(s, view) {
  if (!s.tv) return;
  const { canvas, texture } = s.tv;
  const ctx = canvas.getContext('2d');
  const k = voState.kpis || {};
  const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
  ctx.fillStyle = '#1f3a33';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '800 30px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#f6eddd';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('BREAK ROOM', 28, 34);
  ctx.textAlign = 'right';
  ctx.font = '600 24px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#a7c4bb';
  ctx.fillText(voState.replay !== null ? `Replay ${voClock(voState.replay)}` : `Today ${voState.time || ''}`, canvas.width - 28, 34);
  const inside = view.filter((p) => VO_IN.includes(p.status)).length;
  const tiles = [
    ['In office', `${inside}/${view.length}`],
    ['Orders today', num(k.orders_today)],
    ['Confirmed today', num(k.confirmed_today)],
    ['Pickups today', num(k.pickups_today)],
    ['Delivered this month', num(k.delivered_month)],
    ['RTS rate this month', k.rts_rate_month === undefined || k.rts_rate_month === null ? '—' : `${Number(k.rts_rate_month).toFixed(1)}%`],
  ];
  const w = (canvas.width - 28 * 2 - 16 * 2) / 3;
  tiles.forEach(([label, value], i) => {
    const x = 28 + (i % 3) * (w + 16);
    const y = 66 + Math.floor(i / 3) * 108;
    ctx.fillStyle = '#2b4d44';
    ctx.fillRect(x, y, w, 96);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 42px Inter, system-ui, sans-serif';
    ctx.fillText(value, x + 18, y + 40);
    ctx.fillStyle = '#a7c4bb';
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillText(label, x + 18, y + 76);
  });
  texture.needsUpdate = true;
}

// A desk with nobody at it says whose it is and why: absent (red), on leave,
// rest day, at lunch, out at 17:02, not in yet.
function voSyncPlate(s, p) {
  const seat = s.seats.get(p.id);
  if (!seat) return;
  const f = p.flags || {};
  let text = '';
  let alert = false;
  if (p.status !== 'working') {
    if (f.absent) { text = 'Absent'; alert = true; }
    else if (f.leave) text = /leave/i.test(f.leave) ? f.leave : `${f.leave} leave`;
    else if (f.rest) text = 'Rest day';
    else if (p.status === 'lunch') text = 'At lunch';
    else if (p.status === 'break') text = 'On break';
    else if (p.status === 'left') text = `Out ${p.since}`;
    else text = 'Not in yet';
  }
  const key = `${text}|${alert}`;
  const old = s.plates.get(p.id);
  if (old && old.key === key) return;
  if (old) { s.root.remove(old.sprite); old.sprite.material.map.dispose(); old.sprite.material.dispose(); }
  if (!text) { s.plates.delete(p.id); return; }
  const first = String(p.name || '').split(/\s+/)[0];
  const tex = voTextTexture(`${first} · ${text}`, { bg: alert ? '#fecaca' : '#f1ece2', color: alert ? '#991b1b' : '#475569', size: 30 });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.texture, transparent: true, depthTest: false }));
  sprite.renderOrder = 8;
  sprite.position.set(seat.x, seat.stand ? 1.2 : 1.3, seat.deskZ + (seat.toChair || 1) * 0.3);
  s.root.add(sprite);
  s.plates.set(p.id, { sprite, key, aspect: tex.aspect, shown: true, alert });
}

// What someone at their desk has done today, over their monitor: orders
// confirmed (✓), or RTS parcels scanned in the warehouse (↩).
function voSyncCounter(s, p) {
  const seat = s.seats.get(p.id);
  if (!seat) return;
  const warehouse = employeeDepartment(p) === VO_WAREHOUSE_DEPT;
  const n = Number((warehouse ? p.output?.rts_scans : p.output?.confirmed) || 0);
  const text = n && p.status === 'working' ? `${warehouse ? '↩' : '✓'} ${n}` : '';
  const old = s.counters.get(p.id);
  if (old && old.key === text) return;
  if (old) { s.root.remove(old.sprite); old.sprite.material.map.dispose(); old.sprite.material.dispose(); }
  if (!text) { s.counters.delete(p.id); return; }
  const tex = voTextTexture(text, { bg: '#2f4f45', color: '#ffffff', size: 30, weight: 800 });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.texture, transparent: true, depthTest: false }));
  sprite.renderOrder = 9;
  sprite.position.set(seat.x, seat.stand ? 1.45 : 1.42, seat.deskZ);
  s.root.add(sprite);
  s.counters.set(p.id, { sprite, key: text, aspect: tex.aspect, shown: true });
}

// The light follows the clock being shown: soft morning, bright midday, a
// golden late afternoon, and night with dark windows and glowing screens.
function voApplyDaylight(s) {
  if (!s || !s.hemi) return;
  const h = voAt() / 60;
  let hemi = 0.85;
  let sun = 0.38;
  let sunColor = '#fff7ea';
  const night = h < 6 || h >= 19;
  if (night) { hemi = 0.5; sun = 0.1; sunColor = '#a9b8ff'; }
  else if (h < 9) { hemi = 0.8; sun = 0.34; sunColor = '#ffe7c7'; }
  else if (h >= 16.5) { hemi = 0.76; sun = 0.36; sunColor = '#ffc98f'; }
  s.hemi.intensity = hemi;
  s.sun.intensity = sun;
  s.sun.color.set(sunColor);
  if (s.kit?.pane) {
    s.kit.pane.color.set(night ? '#3c4a72' : '#f5ac83');
    s.kit.pane.emissive.set(night ? '#1c2747' : '#f08a5a');
  }
  s.renderer.setClearColor(night ? (s.dark ? '#111a17' : '#9fb5aa') : (s.dark ? '#1b2723' : '#d3e3da'));
}

/* ─── PEOPLE: picking, the card, seats ─────────────────────────── */

// Whoever is under the pointer, or null.
function voPick(s, e) {
  const rect = s.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  s.ray = s.ray || new THREE.Raycaster();
  s.ray.setFromCamera(ndc, s.camera);
  const groups = [];
  s.chars.forEach((c, id) => { c.group.userData.personId = id; groups.push(c.group); });
  let obj = s.ray.intersectObjects(groups, true)[0]?.object;
  while (obj && obj.userData.personId === undefined) obj = obj.parent;
  return obj ? obj.userData.personId : null;
}

function voOpenCard(id) {
  voState.cardId = id;
  voState.focusId = id;
  voRenderCard();
  voRenderSide();
}

function voCloseCard() {
  voState.cardId = null;
  voRenderCard();
}

// The person card over the floor: where they are, their day against the
// schedule, both breaks, today's work, lates this month, their look and seat.
function voRenderCard() {
  const el = document.getElementById('vo-card');
  if (!el) return;
  const p = voView().find((x) => Number(x.id) === Number(voState.cardId));
  if (!p) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const id = Number(p.id);
  const dept = employeeDepartment(p);
  const status = VO_STATUS[p.status] || VO_STATUS.not_in;
  const f = p.flags || {};
  const pu = p.punches || {};
  const team = (voDepartments(voState.people).find(([d]) => d === dept) || [null, []])[1];
  const seatNo = team.findIndex((m) => Number(m.id) === id);
  const span = (a, b, mins, over) => (a
    ? `${a} – ${b || 'now'} · ${voDuration(mins || 0)}${over ? ` <b class="vo-badge is-alert">+${voDuration(over)}</b>` : ''}`
    : '—');
  const standing = f.absent ? '<b class="vo-badge is-alert">Absent</b>'
    : f.leave ? `<b class="vo-badge is-muted">${escapeHtml(f.leave)}</b>`
    : f.rest ? '<b class="vo-badge is-muted">Rest day</b>'
    : f.late ? `<b class="vo-badge is-warn">Late ${voDuration(f.late)}</b>`
    : pu.time_in ? '<b class="vo-badge is-good">On time</b>' : '';
  const warehouse = dept === VO_WAREHOUSE_DEPT;
  const work = warehouse
    ? ['RTS parcels scanned today', p.output?.rts_scans || 0]
    : ['Orders confirmed today', p.output?.confirmed || 0];
  const look = p.avatar_gender || '';
  const avatar = [['male', 'Male'], ['female', 'Female']].map(([g, label]) => `
    <button class="${look === g ? 'on' : ''}" onclick="voSetAvatar(${id}, '${look === g ? '' : g}')">${label}</button>`).join('');
  el.innerHTML = `
    <div class="vo-card-head">
      <div>
        <div class="vo-card-name">${escapeHtml(p.name)}</div>
        <div class="vo-card-sub"><i style="background:${VO_DEPT_COLOR[dept] || VO_DEPT_COLOR.Unassigned}"></i>${escapeHtml(dept)}${p.role ? ` · ${escapeHtml(p.role)}` : ''}</div>
      </div>
      <button class="vo-card-close" onclick="voCloseCard()" aria-label="Close">&times;</button>
    </div>
    <div class="vo-card-status"><i style="background:${f.overNow || f.absent ? '#dc2626' : status.color}"></i>${status.label}${p.since ? ` <small>${escapeHtml(voFormatSince(p))}</small>` : ''} ${standing}</div>
    <dl class="vo-card-rows">
      <dt>Shift</dt><dd>${p.shift ? `${escapeHtml(p.shift.start)}${p.shift.end ? ` – ${escapeHtml(p.shift.end)}` : ''}` : 'No schedule today'}</dd>
      <dt>Time in</dt><dd>${pu.time_in || '—'}</dd>
      <dt>Lunch</dt><dd>${span(pu.break_out, pu.break_in, f.lunch, f.overLunch)}</dd>
      <dt>15-min break</dt><dd>${span(pu.break2_out, pu.break2_in, f.brk, f.overBreak)}</dd>
      <dt>Time out</dt><dd>${pu.time_out || '—'}</dd>
      <dt>${work[0]}</dt><dd><b>${Number(work[1]).toLocaleString()}</b></dd>
      <dt>Lates this month</dt><dd>${Number(p.lates_this_month || 0)}</dd>
    </dl>
    <div class="vo-card-tools">
      <div><span>Character</span><span class="vo-seg">${avatar}</span></div>
      ${seatNo >= 0 && team.length > 1 ? `<div><span>Seat ${seatNo + 1} of ${team.length}</span><span class="vo-seg">
        <button onclick="voMoveSeat(${id}, -1)" ${seatNo === 0 ? 'disabled' : ''} title="Toward the team wall">◀ Move</button>
        <button onclick="voMoveSeat(${id}, 1)" ${seatNo === team.length - 1 ? 'disabled' : ''} title="Away from the team wall">Move ▶</button>
      </span></div>` : ''}
    </div>`;
}

// HR moves someone one seat along their team (seat 1 is next to the team
// wall). The whole team's order is saved; shown at once, put back on failure.
async function voMoveSeat(id, dir) {
  const person = voState.people.find((p) => Number(p.id) === Number(id));
  if (!person) return;
  const dept = employeeDepartment(person);
  const team = (voDepartments(voState.people).find(([d]) => d === dept) || [null, []])[1];
  const i = team.findIndex((m) => Number(m.id) === Number(id));
  const j = i + dir;
  if (i < 0 || j < 0 || j >= team.length) return;
  const order = team.map((m) => Number(m.id));
  [order[i], order[j]] = [order[j], order[i]];
  const before = new Map(team.map((m) => [Number(m.id), m.desk_order]));
  const apply = (orderOf) => {
    team.forEach((m) => { m.desk_order = orderOf(Number(m.id)); });
    voRenderSide();
    voRenderCard();
    if (voState.scene) voSyncPeople();
  };
  apply((mid) => order.indexOf(mid));
  try {
    await authorizedJsonRequest('/virtual-office/seats', { method: 'PUT', body: JSON.stringify({ ids: order }) });
  } catch (error) {
    apply((mid) => before.get(mid) ?? null);
    showToast('error', 'Seat not saved', error.message || 'Try again.');
  }
}

/* ─── REPLAY, EXPORT ───────────────────────────────────────────── */

// Scrub back through the day; anything at or past now is live again.
function voSetReplay(value) {
  const now = voToMin(voState.time) ?? 0;
  voState.replay = value === null || value >= now ? null : value;
  voSyncReplayControl();
  voRenderSide();
  voRenderCard();
  if (voState.scene) voSyncPeople();
}

function voSyncReplayControl() {
  const range = document.getElementById('vo-replay');
  const label = document.getElementById('vo-replay-time');
  const live = document.getElementById('vo-live');
  if (!range || !label || !live) return;
  const now = voToMin(voState.time) ?? 1380;
  range.max = String(Math.max(Number(range.min) + 5, now));
  if (voState.replay === null) range.value = range.max;
  label.textContent = voState.replay === null ? `Now${voState.time ? ` · ${voState.time}` : ''}` : `Replay · ${voClock(voState.replay)}`;
  live.classList.toggle('on', voState.replay === null);
}

// Today's attendance as a spreadsheet: shift, punches, lateness, both
// breaks with how far over they ran, and the day's work.
function voExportDay() {
  const at = voToMin(voState.time) ?? 0;
  const standingLabel = {
    late: 'Late', on_time: 'On time', absent: 'Absent', expected: 'Not in yet',
    rest_day: 'Rest day', on_leave: 'On leave', unscheduled: 'No schedule',
  };
  const header = ['Name', 'Department', 'Role', 'Shift start', 'Shift end', 'Time in', 'Late (min)',
    'Lunch out', 'Lunch in', 'Lunch (min)', 'Over lunch (min)', 'Break out', 'Break in', 'Break (min)', 'Over break (min)',
    'Time out', 'Status now', 'Day', 'Orders confirmed', 'RTS scans', 'Lates this month'];
  const rows = voDepartments(voState.people).flatMap(([dept, members]) => members.map((p) => {
    const f = voFlags(p, { status: p.status, since: p.since }, at);
    const pu = p.punches || {};
    return [p.name, dept, p.role || '', p.shift?.start || '', p.shift?.end || '', pu.time_in || '', f.late || '',
      pu.break_out || '', pu.break_in || '', f.lunch ?? '', f.overLunch || '', pu.break2_out || '', pu.break2_in || '', f.brk ?? '', f.overBreak || '',
      pu.time_out || '', (VO_STATUS[p.status] || VO_STATUS.not_in).label, standingLabel[p.standing] || '',
      p.output?.confirmed || 0, p.output?.rts_scans || 0, p.lates_this_month || 0];
  }));
  const cell = (v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `virtual-office-${voState.date || 'today'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


function voDisposeScene() {
  const s = voState.scene;
  if (!s) return;
  cancelAnimationFrame(s.raf);
  window.removeEventListener('resize', s.onResize);
  s.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    mats.forEach((mat) => {
      if (mat.map) mat.map.dispose();
      mat.dispose();
    });
  });
  s.renderer.dispose();
  voState.scene = null;
}

window.renderVirtualOfficePage = renderVirtualOfficePage;
window.initVirtualOfficePage = initVirtualOfficePage;
window.voSetAvatar = voSetAvatar;
window.voSetReplay = voSetReplay;
window.voOpenCard = voOpenCard;
window.voCloseCard = voCloseCard;
window.voMoveSeat = voMoveSeat;
window.voExportDay = voExportDay;
