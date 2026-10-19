/* ═══════════════════════════════════════════════════════════
   VIRTUAL OFFICE — today's attendance as a 3D floor
   Every active account is a cartoon character with a desk in its
   department's cluster. Timed in → at the desk; lunch or the 15-minute
   break → the break room; timed out → walks out the door. Not timed in
   yet → no character, just an empty desk. Backed by /api/virtual-office
   (HR and the super admin only), polled every 30 seconds.
   Three.js is fetched only when the page opens, so nobody else pays for it.
   Loaded before app.js; it leans on app.js globals (App, escapeHtml,
   authorizedJsonRequest, employeeDepartment, DEPARTMENT_ORDER) read at
   call time.
   ═══════════════════════════════════════════════════════════ */

const VO_THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js';
const VO_POLL_MS = 30000;
const VO_WALK_SPEED = 2.4; // floor units per second
const VO_MAX_RADIUS = 130;  // furthest the camera zooms out (a phone needs it all)

const VO_STATUS = {
  working: { label: 'At desk', color: '#059669' },
  lunch: { label: 'Lunch break', color: '#f59e0b' },
  break: { label: '15-min break', color: '#3b82f6' },
  left: { label: 'Timed out', color: '#94a3b8' },
  not_in: { label: 'Not in yet', color: '#cbd5e1' },
};
// Shirt colour per department, so a cluster reads as one team from far away.
const VO_DEPT_COLOR = {
  Management: '#7c3aed',
  'Human Resources': '#db2777',
  Operations: '#0891b2',
  'Sales & Marketing': '#ea580c',
  CSR: '#2563eb',
  RMO: '#16a34a',
  Logistics: '#ca8a04',
  Trainee: '#64748b',
  Unassigned: '#475569',
};
const VO_SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const VO_HAIR = ['#2b1b0e', '#4a2c17', '#111111', '#6b3e1f', '#3b2a1a'];

// Desk geometry, in floor units. A cluster is two rows of desks facing each
// other; the corridor runs along x at z = 0 with clusters above and below it.
const VO_DESK_W = 1.7;
const VO_NEAR_CHAIR = 1.3;  // |z| of the chairs on the corridor side
const VO_NEAR_DESK = 2.0;
const VO_FAR_DESK = 2.8;
const VO_FAR_CHAIR = 3.5;
const VO_BACK_LANE = 4.4;   // |z| of the walkway behind a cluster
const VO_POD_GAP = 2.0;

const voState = {
  people: [],
  date: '',
  time: '',
  error: '',
  loading: false,
  scene: null,
  timer: null,
  focusId: null,
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

// Minutes since an HH:MM Manila punch, against the server's HH:MM "now".
function voMinutesSince(since, now) {
  if (!since || !now) return null;
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  return Math.max(0, toMin(now) - toMin(since));
}

function voFormatSince(person) {
  if (!person.since) return '';
  const mins = voMinutesSince(person.since, voState.time);
  const ago = mins === null ? '' : mins < 60 ? ` · ${mins}m` : ` · ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  const verb = person.status === 'left' ? 'out at' : 'since';
  return `${verb} ${person.since}${person.status === 'left' ? '' : ago}`;
}

// Departments in org order, each with its people sorted by name, so a seat
// stays put from one refresh to the next.
function voDepartments(people) {
  const groups = new Map();
  people.forEach((person) => {
    const dept = employeeDepartment(person);
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept).push(person);
  });
  const rank = (name) => { const i = DEPARTMENT_ORDER.indexOf(name); return i === -1 ? DEPARTMENT_ORDER.length : i; };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, members]) => [name, members.sort((a, b) => String(a.name).localeCompare(String(b.name)))]);
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
      <button class="btn btn-secondary btn-sm" onclick="voResetView()">Reset view</button>
      <button class="btn btn-secondary btn-sm" onclick="voRefresh()">Refresh</button>
    </div>
  </div>
  <div class="vo-layout">
    <div class="card vo-stage-card">
      <div class="vo-stage" id="vo-stage">
        <div class="vo-stage-msg" id="vo-stage-msg">Loading the office…</div>
      </div>
      <div class="vo-legend">
        ${['working', 'lunch', 'break'].map((s) => `<span><i style="background:${VO_STATUS[s].color}"></i>${VO_STATUS[s].label}</span>`).join('')}
        <span class="vo-hint">Drag to turn · scroll or pinch to zoom · click a name to find them</span>
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
    voState.error = '';
  } catch (error) {
    voState.error = error.message || 'Could not load attendance.';
  }
  voState.loading = false;
  voRenderSide();
  if (voState.scene) voSyncPeople();
}

function voRefresh() {
  voLoad().catch(() => {});
}

function voRenderSide() {
  const side = document.getElementById('vo-side');
  if (!side) return;
  if (voState.error) {
    side.innerHTML = `<div class="vo-side-empty" style="color:var(--danger)">${escapeHtml(voState.error)}</div>`;
    return;
  }
  const people = voState.people;
  const count = (s) => people.filter((p) => p.status === s).length;
  const tiles = ['working', 'lunch', 'break', 'left', 'not_in'].map((s) => `
    <div class="vo-count"><b style="color:${VO_STATUS[s].color}">${count(s)}</b><span>${VO_STATUS[s].label}</span></div>`).join('');
  const depts = voDepartments(people).map(([dept, members]) => `
    <div class="vo-dept">
      <div class="vo-dept-head"><i style="background:${VO_DEPT_COLOR[dept] || VO_DEPT_COLOR.Unassigned}"></i>${escapeHtml(dept)}
        <span>${members.filter((m) => ['working', 'lunch', 'break'].includes(m.status)).length}/${members.length} in</span></div>
      ${members.map((m) => {
        const s = VO_STATUS[m.status] || VO_STATUS.not_in;
        const inside = ['working', 'lunch', 'break'].includes(m.status);
        return `<button class="vo-person${voState.focusId === m.id ? ' active' : ''}${inside ? '' : ' away'}" ${inside ? `onclick="voFocus(${Number(m.id)})"` : 'disabled'}>
          <i style="background:${s.color}"></i>
          <span class="vo-person-name">${escapeHtml(m.name)}</span>
          <span class="vo-person-status">${s.label}${m.since ? ` <small>${escapeHtml(voFormatSince(m))}</small>` : ''}</span>
        </button>`;
      }).join('')}
    </div>`).join('');
  side.innerHTML = `
    <div class="vo-side-head">Today${voState.time ? ` · ${escapeHtml(voState.time)}` : ''}</div>
    <div class="vo-counts">${tiles}</div>
    <div class="vo-depts">${depts || '<div class="vo-side-empty">No active accounts.</div>'}</div>`;
}

/* ─── SCENE ────────────────────────────────────────────────── */

function voMat(color) {
  return new THREE.MeshLambertMaterial({ color });
}

// A canvas-drawn text label as a sprite (names) or a flat floor decal (team names).
function voTextTexture(text, { color = '#0f172a', bg = 'rgba(255,255,255,0.92)', dot = null, size = 34 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  const pad = 18;
  const dotW = dot ? size * 0.9 : 0;
  const width = Math.ceil(ctx.measureText(text).width + pad * 2 + dotW);
  const height = Math.ceil(size * 1.7);
  canvas.width = width;
  canvas.height = height;
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
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

// A team (or room) name in white on its colour, hung high over the area.
function voSign(text, color, x, z) {
  const { texture, aspect } = voTextTexture(text.toUpperCase(), { color: '#ffffff', bg: color, size: 30 });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false }));
  const h = 0.03;
  sprite.scale.set(h * aspect, h, 1);
  sprite.position.set(x, 2.6, z);
  sprite.renderOrder = 9;
  return sprite;
}

function voNameSprite(name, status) {
  const { texture, aspect } = voTextTexture(name, { dot: (VO_STATUS[status] || VO_STATUS.working).color });
  // Same size on screen however far the camera is, so names stay readable.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false }));
  const h = 0.034;
  sprite.scale.set(h * aspect, h, 1);
  sprite.renderOrder = 10;
  return sprite;
}

// Lay the clusters out along both sides of the corridor, each new cluster on
// whichever side is shorter so the floor stays roughly square.
function voLayout(departments) {
  const pods = [];
  let topX = 0;
  let bottomX = 0;
  departments.forEach(([dept, members]) => {
    // At least two desks wide, so the team's name fits in front of it.
    const cols = Math.max(2, Math.ceil(members.length / 2));
    const width = cols * VO_DESK_W;
    const side = topX <= bottomX ? -1 : 1; // -1 above the corridor, +1 below
    const x0 = side === -1 ? topX : bottomX;
    if (side === -1) topX += width + VO_POD_GAP; else bottomX += width + VO_POD_GAP;
    const seats = members.map((person, i) => {
      const col = Math.floor(i / 2);
      const far = i % 2 === 1;
      const x = x0 + col * VO_DESK_W + VO_DESK_W / 2;
      const chairZ = side * (far ? VO_FAR_CHAIR : VO_NEAR_CHAIR);
      // How a seat reaches the corridor: the near row steps straight out; the
      // far row goes round the back of the cluster and down its side lane.
      const sideLaneX = x0 + width + VO_POD_GAP / 2;
      const exit = far
        ? [{ x, z: side * VO_BACK_LANE }, { x: sideLaneX, z: side * VO_BACK_LANE }, { x: sideLaneX, z: 0 }]
        : [{ x, z: 0 }];
      return {
        person,
        x,
        z: chairZ,
        deskZ: side * (far ? VO_FAR_DESK : VO_NEAR_DESK),
        face: far ? (side === -1 ? 0 : Math.PI) : (side === -1 ? Math.PI : 0),
        exit,
      };
    });
    pods.push({ dept, side, x0, width, seats });
  });
  const floorEnd = Math.max(topX, bottomX, 6);
  return { pods, floorEnd };
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
  renderer.setClearColor(dark ? '#0b1220' : '#eef2f7');
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, stage.clientWidth / Math.max(1, stage.clientHeight), 0.1, 500);
  scene.add(new THREE.HemisphereLight('#ffffff', dark ? '#334155' : '#cbd5e1', 0.85));
  const sun = new THREE.DirectionalLight('#ffffff', 0.55);
  sun.position.set(8, 20, 12);
  scene.add(sun);

  const s = {
    renderer, scene, camera, stage, dark,
    chars: new Map(),
    monitors: new Map(),
    seats: new Map(),
    breakSlots: [],
    door: null,
    breakEntry: null,
    orbit: { theta: -0.18, phi: 0.82, radius: 30, target: new THREE.Vector3() },
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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', s.onResize);

  voSyncPeople(true);
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

// Floor, the desk clusters, the break room and the door. Rebuilt whenever the
// roster changes shape (someone added or moved department); otherwise kept.
function voBuildFloor(s) {
  const T = THREE;
  const root = s.root;
  while (root.children.length) root.remove(root.children[0]);
  s.monitors.clear();
  s.seats.clear();

  const departments = voDepartments(voState.people);
  s.rosterKey = departments.map(([d, m]) => `${d}:${m.map((p) => p.id).join(',')}`).join('|');
  const { pods, floorEnd } = voLayout(departments);

  const breakX0 = floorEnd + 1;
  const breakW = 9;
  const doorX = -3.5;
  const minX = doorX - 1.5;
  const maxX = breakX0 + breakW + 1;
  const depth = (VO_BACK_LANE + 1.5) * 2;

  const floor = new T.Mesh(new T.BoxGeometry(maxX - minX, 0.2, depth), voMat(s.dark ? '#1e293b' : '#f8fafc'));
  floor.position.set((minX + maxX) / 2, -0.1, 0);
  root.add(floor);
  const corridor = new T.Mesh(new T.PlaneGeometry(breakX0 - minX, 1.6), voMat(s.dark ? '#273449' : '#e2e8f0'));
  corridor.rotation.x = -Math.PI / 2;
  corridor.position.set((minX + breakX0) / 2, 0.005, 0);
  root.add(corridor);

  // Low walls on the long sides only, so the camera always sees in.
  const wallMat = voMat(s.dark ? '#334155' : '#dbe3ee');
  [-1, 1].forEach((side) => {
    const wall = new T.Mesh(new T.BoxGeometry(maxX - minX, 0.6, 0.15), wallMat);
    wall.position.set((minX + maxX) / 2, 0.3, side * depth / 2);
    root.add(wall);
  });

  const deskMat = voMat(s.dark ? '#a8a29e' : '#d6c3a5');
  const legMat = voMat('#64748b');
  const chairMat = voMat(s.dark ? '#475569' : '#334155');
  const deskGeo = new T.BoxGeometry(VO_DESK_W - 0.15, 0.08, 0.75);
  const legGeo = new T.BoxGeometry(0.06, 0.7, 0.06);
  const monitorGeo = new T.BoxGeometry(0.6, 0.38, 0.05);
  const seatGeo = new T.BoxGeometry(0.5, 0.08, 0.5);
  const backGeo = new T.BoxGeometry(0.5, 0.5, 0.07);

  pods.forEach((pod) => {
    const color = VO_DEPT_COLOR[pod.dept] || VO_DEPT_COLOR.Unassigned;
    // A team-coloured rug under the cluster, and the team's name on a sign
    // floating above it.
    const rugDepth = VO_FAR_CHAIR - VO_NEAR_CHAIR + 1.2;
    const rug = new T.Mesh(new T.PlaneGeometry(pod.width + 0.6, rugDepth),
      new T.MeshLambertMaterial({ color, transparent: true, opacity: s.dark ? 0.22 : 0.14 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(pod.x0 + pod.width / 2, 0.01, pod.side * (VO_NEAR_CHAIR + VO_FAR_CHAIR) / 2);
    root.add(rug);

    // On the cluster's far edge as the camera sees it, so it hangs above the
    // team rather than over their names.
    root.add(voSign(pod.dept, color, pod.x0 + pod.width / 2, pod.side === -1 ? -VO_BACK_LANE : 0.9));

    pod.seats.forEach((seat) => {
      const desk = new T.Group();
      const top = new T.Mesh(deskGeo, deskMat);
      top.position.y = 0.74;
      desk.add(top);
      [[-0.7, -0.3], [0.7, -0.3], [-0.7, 0.3], [0.7, 0.3]].forEach(([lx, lz]) => {
        const leg = new T.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.36, lz);
        desk.add(leg);
      });
      const monitor = new T.Mesh(monitorGeo, new T.MeshLambertMaterial({ color: '#1f2937', emissive: '#000000' }));
      // The monitor sits on the far half of the desk, facing the chair.
      const toChair = Math.sign(seat.z - seat.deskZ);
      monitor.position.set(0, 1.02, -toChair * 0.18);
      desk.add(monitor);
      desk.position.set(seat.x, 0, seat.deskZ);
      root.add(desk);
      s.monitors.set(seat.person.id, monitor);

      const chair = new T.Group();
      const seatMesh = new T.Mesh(seatGeo, chairMat);
      seatMesh.position.y = 0.45;
      chair.add(seatMesh);
      const back = new T.Mesh(backGeo, chairMat);
      back.position.set(0, 0.72, toChair * 0.24);
      chair.add(back);
      chair.position.set(seat.x, 0, seat.z);
      root.add(chair);
      s.seats.set(seat.person.id, seat);
    });
  });

  // Break room: a coloured floor, two round tables with stools, a sofa and a
  // coffee counter. Slots are where people stand or sit while on break.
  const breakFloor = new T.Mesh(new T.PlaneGeometry(breakW, depth - 0.4), voMat(s.dark ? '#3b2f1e' : '#fef3c7'));
  breakFloor.rotation.x = -Math.PI / 2;
  breakFloor.position.set(breakX0 + breakW / 2, 0.01, 0);
  root.add(breakFloor);
  root.add(voSign('Break Room', '#d97706', breakX0 + breakW / 2, -VO_BACK_LANE));

  const tableMat = voMat('#f5f5f4');
  const tables = [{ x: breakX0 + 2.6, z: -2.6 }, { x: breakX0 + 2.6, z: 2.6 }, { x: breakX0 + 6.4, z: -2.6 }];
  s.breakSlots = [];
  tables.forEach((t) => {
    const top = new T.Mesh(new T.CylinderGeometry(0.8, 0.8, 0.08, 20), tableMat);
    top.position.set(t.x, 0.74, t.z);
    root.add(top);
    const stem = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 0.7, 8), legMat);
    stem.position.set(t.x, 0.36, t.z);
    root.add(stem);
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const sx = t.x + Math.cos(a) * 1.25;
      const sz = t.z + Math.sin(a) * 1.25;
      const stool = new T.Mesh(new T.CylinderGeometry(0.22, 0.22, 0.45, 12), voMat('#f59e0b'));
      stool.position.set(sx, 0.22, sz);
      root.add(stool);
      s.breakSlots.push({ x: sx, z: sz, face: Math.atan2(t.x - sx, t.z - sz) });
    }
  });
  const sofa = new T.Group();
  const sofaMat = voMat('#0d9488');
  const sofaBase = new T.Mesh(new T.BoxGeometry(3, 0.45, 0.9), sofaMat);
  sofaBase.position.y = 0.22;
  sofa.add(sofaBase);
  const sofaBack = new T.Mesh(new T.BoxGeometry(3, 0.6, 0.25), sofaMat);
  sofaBack.position.set(0, 0.6, 0.35);
  sofa.add(sofaBack);
  sofa.position.set(breakX0 + 6.4, 0, 3.6);
  root.add(sofa);
  [-1, 0, 1].forEach((k) => s.breakSlots.push({ x: breakX0 + 6.4 + k * 0.95, z: 3.25, face: Math.PI }));
  const counter = new T.Mesh(new T.BoxGeometry(0.8, 1, 2.4), voMat(s.dark ? '#57534e' : '#e7e5e4'));
  counter.position.set(breakX0 + breakW - 0.5, 0.5, 0);
  root.add(counter);
  const coffee = new T.Mesh(new T.BoxGeometry(0.4, 0.5, 0.4), voMat('#1c1917'));
  coffee.position.set(breakX0 + breakW - 0.5, 1.25, -0.6);
  root.add(coffee);
  // More people on break than seats: they queue for coffee along the counter.
  for (let i = 0; i < 12; i += 1) {
    s.breakSlots.push({ x: breakX0 + breakW - 1.5 - Math.floor(i / 6) * 0.8, z: -2.2 + (i % 6) * 0.8, face: Math.PI / 2 });
  }
  s.breakEntry = { x: breakX0 + 0.8, z: 0 };

  // The door, on the corridor's open end.
  const doorFrame = new T.Mesh(new T.BoxGeometry(0.2, 2.2, 1.8), voMat('#475569'));
  doorFrame.position.set(doorX - 0.6, 1.1, 0);
  root.add(doorFrame);
  const doorPanel = new T.Mesh(new T.BoxGeometry(0.1, 2, 1.4), voMat('#92400e'));
  doorPanel.position.set(doorX - 0.5, 1, 0);
  root.add(doorPanel);
  s.door = { x: doorX, z: 0 };

  // Plants for a bit of life at the ends of the corridor.
  [[doorX + 0.5, -1.4], [doorX + 0.5, 1.4], [breakX0 - 0.4, -1.4], [breakX0 - 0.4, 1.4]].forEach(([px, pz]) => {
    const pot = new T.Mesh(new T.CylinderGeometry(0.22, 0.18, 0.4, 10), voMat('#b45309'));
    pot.position.set(px, 0.2, pz);
    root.add(pot);
    const leaves = new T.Mesh(new T.SphereGeometry(0.42, 10, 8), voMat('#16a34a'));
    leaves.position.set(px, 0.75, pz);
    root.add(leaves);
  });

  // Start square-on with a slight turn, far enough back that the whole floor
  // fits the stage's width.
  const centerX = (minX + maxX) / 2;
  const aspect = s.camera.aspect || 1.6;
  const halfFov = Math.atan(Math.tan(T.MathUtils.degToRad(s.camera.fov / 2)) * aspect);
  const fit = ((maxX - minX) / 2) / Math.tan(halfFov) + depth / 2;
  s.home = { theta: -0.18, phi: 0.82, radius: Math.min(VO_MAX_RADIUS, Math.max(12, fit * 0.86)), target: new T.Vector3(centerX, 0, 0.6) };
  if (!s.orbitSet) {
    Object.assign(s.orbit, { ...s.home, target: s.home.target.clone() });
    s.orbitSet = true;
  }

  // Characters live outside the floor group's rebuild; re-attach them.
  s.chars.forEach((c) => root.add(c.group));
}

function voMakeCharacter(person) {
  const T = THREE;
  const h = voHash(person.id);
  const shirt = VO_DEPT_COLOR[employeeDepartment(person)] || VO_DEPT_COLOR.Unassigned;
  const group = new T.Group();
  const body = new T.Group();
  group.add(body);

  const legMat = voMat('#1e293b');
  const legs = [-0.11, 0.11].map((lx) => {
    const pivot = new T.Group();
    pivot.position.set(lx, 0.5, 0);
    const leg = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.5, 8), legMat);
    leg.position.y = -0.25;
    pivot.add(leg);
    body.add(pivot);
    return pivot;
  });
  const torso = new T.Mesh(new T.CylinderGeometry(0.22, 0.27, 0.55, 14), voMat(shirt));
  torso.position.y = 0.78;
  body.add(torso);
  const shoulders = new T.Mesh(new T.SphereGeometry(0.22, 14, 10), voMat(shirt));
  shoulders.scale.set(1, 0.45, 1);
  shoulders.position.y = 1.05;
  body.add(shoulders);
  const head = new T.Mesh(new T.SphereGeometry(0.24, 16, 12), voMat(VO_SKIN[h % VO_SKIN.length]));
  head.position.y = 1.32;
  body.add(head);
  const hair = new T.Mesh(new T.SphereGeometry(0.25, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), voMat(VO_HAIR[(h >> 3) % VO_HAIR.length]));
  hair.position.y = 1.35;
  hair.rotation.x = -0.25;
  body.add(hair);
  const eyeMat = voMat('#111827');
  [-0.08, 0.08].forEach((ex) => {
    const eye = new T.Mesh(new T.SphereGeometry(0.03, 8, 6), eyeMat);
    eye.position.set(ex, 1.34, 0.22);
    body.add(eye);
  });

  const label = voNameSprite(person.name, person.status);
  label.position.y = 1.85;
  group.add(label);

  return { group, body, legs, label, path: [], status: null, face: 0, leaving: false, walkT: h % 7 };
}

// Where a status sends someone, as a resting point with exits to the corridor.
function voDestination(s, person, slotIndex) {
  if (person.status === 'working') {
    const seat = s.seats.get(person.id);
    if (seat) return { x: seat.x, z: seat.z, face: seat.face, exit: seat.exit, sit: true };
  }
  if (person.status === 'lunch' || person.status === 'break') {
    const slot = s.breakSlots[slotIndex % s.breakSlots.length];
    return { x: slot.x, z: slot.z, face: slot.face, exit: [s.breakEntry], sit: slotIndex < s.breakSlots.length - 12 };
  }
  return { x: s.door.x, z: s.door.z, face: -Math.PI / 2, exit: [], sit: false, door: true };
}

// A walk from one resting point to another: out of the first along its exits,
// along the corridor, and in along the second's exits in reverse.
function voRoute(from, to) {
  return [...(from.exit || []), ...[...(to.exit || [])].reverse(), { x: to.x, z: to.z }];
}

function voSyncPeople(initial = false) {
  const s = voState.scene;
  if (!s) return;
  const departments = voDepartments(voState.people);
  const rosterKey = departments.map(([d, m]) => `${d}:${m.map((p) => p.id).join(',')}`).join('|');
  // A new floor moves desks, so everyone already inside walks to the new spot.
  const rebuilt = rosterKey !== s.rosterKey;
  if (rebuilt) voBuildFloor(s);

  const msg = document.getElementById('vo-stage-msg');
  if (msg) msg.remove();

  // Break-room spots stick: whoever already holds one keeps it, so a person
  // coming back from break never makes the others shuffle seats.
  const onBreakNow = (p) => p.status === 'lunch' || p.status === 'break';
  const slotOf = new Map();
  const taken = new Set();
  voState.people.forEach((p) => {
    const c = s.chars.get(p.id);
    if (onBreakNow(p) && c && onBreakNow(c) && Number.isInteger(c.slot) && !taken.has(c.slot)) {
      slotOf.set(p.id, c.slot);
      taken.add(c.slot);
    }
  });
  let nextFree = 0;
  voState.people.forEach((p) => {
    if (!onBreakNow(p) || slotOf.has(p.id)) return;
    while (taken.has(nextFree)) nextFree += 1;
    slotOf.set(p.id, nextFree);
    taken.add(nextFree);
  });

  const inside = new Set();
  voState.people.forEach((person) => {
    const onBreak = onBreakNow(person);
    const slotIndex = onBreak ? slotOf.get(person.id) : null;
    const present = ['working', 'lunch', 'break'].includes(person.status);
    let c = s.chars.get(person.id);
    const monitor = s.monitors.get(person.id);
    if (monitor) monitor.material.emissive.set(person.status === 'working' ? (s.dark ? '#1d4ed8' : '#60a5fa') : '#000000');

    if (!present) {
      // Timed out while we watched: walk to the door, then go.
      if (c && !c.leaving) {
        const dest = voDestination(s, person, null);
        c.path = voRoute(c.rest || dest, dest);
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
      if (initial) {
        // First paint: everyone already where they belong, no parade.
        c.group.position.set(dest.x, 0, dest.z);
        c.face = dest.face;
        c.path = [];
      } else {
        // Just timed in: walk in from the door.
        c.group.position.set(s.door.x, 0, s.door.z);
        c.path = voRoute({ exit: [] }, dest);
      }
      c.status = person.status;
      c.rest = dest;
      c.slot = slotIndex;
      return;
    }
    if (rebuilt || c.status !== person.status || (onBreak && c.slot !== slotIndex) || c.leaving) {
      c.path = voRoute(c.rest || dest, dest);
      c.leaving = false;
      c.status = person.status;
      c.rest = dest;
      c.slot = slotIndex;
      voSetLabel(c, person);
    }
  });
  // Accounts deactivated or gone from the roster lose their character outright.
  s.chars.forEach((c, id) => {
    if (!inside.has(id) && !c.leaving) { s.root.remove(c.group); s.chars.delete(id); }
  });
}

function voSetLabel(c, person) {
  c.group.remove(c.label);
  c.label.material.map.dispose();
  c.label.material.dispose();
  c.label = voNameSprite(person.name, person.status);
  c.label.position.y = 1.85;
  c.group.add(c.label);
}

function voTick(s, dt) {
  s.chars.forEach((c, id) => {
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

    const sitting = !moving && c.rest?.sit;
    if (moving) {
      c.walkT += dt * 9;
      const swing = Math.sin(c.walkT) * 0.6;
      c.legs[0].rotation.x = swing;
      c.legs[1].rotation.x = -swing;
      c.body.position.y = Math.abs(Math.sin(c.walkT)) * 0.05;
    } else if (sitting) {
      c.legs[0].rotation.x = -1.4;
      c.legs[1].rotation.x = -1.4;
      c.body.position.y = -0.04;
    } else {
      c.legs[0].rotation.x = 0;
      c.legs[1].rotation.x = 0;
      c.body.position.y = 0;
    }
    // A slow breathing bob so the floor never looks frozen.
    c.body.scale.y = 1 + Math.sin(s.clock * 2 + c.walkT) * (moving ? 0 : 0.012);
  });

  // Ease the camera toward a person someone clicked in the list.
  if (s.focusTo) {
    const c = s.chars.get(s.focusTo);
    if (!c) s.focusTo = null;
    else {
      const k = Math.min(1, dt * 3);
      s.orbit.target.lerp(new THREE.Vector3(c.group.position.x, 0.8, c.group.position.z), k);
      s.orbit.radius += (9 - s.orbit.radius) * k;
    }
  }
}

function voApplyOrbit(s) {
  const o = s.orbit;
  const { camera } = s;
  camera.position.set(
    o.target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
    o.target.y + o.radius * Math.cos(o.phi),
    o.target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
  );
  camera.lookAt(o.target);
}

// Drag to turn, wheel or pinch to zoom, two-finger drag (or right drag) to pan.
function voBindControls(s) {
  const el = s.renderer.domElement;
  const o = s.orbit;
  const pointers = new Map();
  let pinch = 0;
  let panning = false;
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    panning = e.button === 2 || e.shiftKey;
    s.focusTo = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  el.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) o.radius = Math.min(VO_MAX_RADIUS, Math.max(5, o.radius * (pinch / d)));
      pinch = d;
      return;
    }
    if (panning) {
      const scale = o.radius / 600;
      const cos = Math.cos(o.theta);
      const sin = Math.sin(o.theta);
      o.target.x -= (dx * cos + dy * sin) * scale;
      o.target.z -= (-dx * sin + dy * cos) * scale;
      return;
    }
    o.theta -= dx * 0.006;
    o.phi = Math.min(1.35, Math.max(0.25, o.phi - dy * 0.005));
  });
  const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    s.focusTo = null;
    o.radius = Math.min(VO_MAX_RADIUS, Math.max(5, o.radius * (1 + Math.sign(e.deltaY) * 0.1)));
  }, { passive: false });
}

function voFocus(id) {
  const s = voState.scene;
  voState.focusId = id;
  if (s) s.focusTo = id;
  voRenderSide();
}

function voResetView() {
  const s = voState.scene;
  voState.focusId = null;
  if (s && s.home) {
    s.focusTo = null;
    Object.assign(s.orbit, { ...s.home, target: s.home.target.clone() });
  }
  voRenderSide();
}

function voDisposeScene() {
  const s = voState.scene;
  if (!s) return;
  cancelAnimationFrame(s.raf);
  window.removeEventListener('resize', s.onResize);
  s.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
  s.renderer.dispose();
  voState.scene = null;
}

window.renderVirtualOfficePage = renderVirtualOfficePage;
window.initVirtualOfficePage = initVirtualOfficePage;
