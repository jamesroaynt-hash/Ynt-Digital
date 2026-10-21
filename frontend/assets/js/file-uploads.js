/* ═══════════════════════════════════════════════════════════
   FILE UPLOADS — drag files in, they're stored in Supabase Storage
   Two categories, one folder per page under each:
     Page Details / <page>     Customer Feedbacks / <page>
   Backed by /api/uploads. Every signed-in user uploads and views; the
   uploader or an Administrator deletes.
   Loaded before app.js; it leans on app.js globals (App, escapeHtml,
   authorizedJsonRequest, getApiBase, getAuthToken, showToast) read at
   call time.
   ═══════════════════════════════════════════════════════════ */

const fuState = {
  status: null,
  pages: [],
  category: 'Page Details',
  page: '',
  queue: [],
  uploading: false,
  files: [],
};

function renderFileUploadsPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>File Uploads</h1>
      <p>Drop images and files for a page. They're saved in a folder for that page.</p>
    </div>
  </div>
  <div id="fu-body"><div class="card"><div class="empty-state"><h3>Loading</h3></div></div></div>`;
}

async function initFileUploadsPage() {
  try {
    const [status, pages] = await Promise.all([
      authorizedJsonRequest('/uploads/status'),
      authorizedJsonRequest('/uploads/pages').catch(() => ({ pages: [] })),
    ]);
    fuState.status = status;
    fuState.pages = Array.isArray(pages?.pages) ? pages.pages : [];
  } catch (error) {
    const body = document.getElementById('fu-body');
    if (body) body.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  renderFuBody();
  if (fuState.status.configured) fuLoadFiles();
}

function renderFuBody() {
  const body = document.getElementById('fu-body');
  const s = fuState.status;
  if (!body || !s) return;

  if (!s.configured) {
    body.innerHTML = `
      <div class="card"><div class="empty-state">
        <h3>File storage is not set up yet</h3>
        <p>Set <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> on the server, then come back.</p>
      </div></div>`;
    return;
  }

  const categories = (s.categories || ['Page Details', 'Customer Feedbacks']).map((c) =>
    `<button class="filter-pill ${fuState.category === c ? 'active' : ''}" type="button" onclick="fuSetCategory('${escapeHtml(c)}')">${escapeHtml(c)}</button>`).join('');
  const options = fuState.pages.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('');

  body.innerHTML = `
    <div class="card">
      <div class="fu-controls">
        <div class="form-group">
          <label class="form-label">Folder</label>
          <div class="fu-pills">${categories}</div>
        </div>
        <div class="form-group fu-page-field">
          <label class="form-label" for="fu-page">Page</label>
          <input class="form-control" id="fu-page" list="fu-page-list" placeholder="Pick or type a page name"
            value="${escapeHtml(fuState.page)}" oninput="fuSetPage(this.value)" autocomplete="off">
          <datalist id="fu-page-list">${options}</datalist>
        </div>
      </div>
      <div class="fu-drop" id="fu-drop" tabindex="0" role="button" aria-label="Drop files or click to choose"
        onclick="document.getElementById('fu-file').click()"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('fu-file').click();}"
        ondragover="fuDragOver(event)" ondragleave="fuDragLeave(event)" ondrop="fuDrop(event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/></svg>
        <strong>Drag files here</strong>
        <span id="fu-drop-hint">${fuDropHint()}</span>
        <input type="file" id="fu-file" multiple hidden onchange="fuAddFiles(this.files); this.value='';">
      </div>
      <div id="fu-queue"></div>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-header"><div class="card-title" id="fu-files-title">Files</div></div>
      <div id="fu-files"><div class="empty-state"><p>Loading</p></div></div>
    </div>`;
  renderFuQueue();
}

function fuDropHint() {
  const max = fuState.status?.max_file_mb || 50;
  return fuState.page
    ? `Goes to ${escapeHtml(fuState.category)} / ${escapeHtml(fuState.page)} — or click to choose. Up to ${max} MB each.`
    : `Pick a page first — or click to choose. Up to ${max} MB each.`;
}

function fuRefreshHint() {
  const hint = document.getElementById('fu-drop-hint');
  if (hint) hint.innerHTML = fuDropHint();
}

function fuSetCategory(category) {
  fuState.category = category;
  document.querySelectorAll('.fu-pills .filter-pill').forEach((btn) => btn.classList.toggle('active', btn.textContent === category));
  fuRefreshHint();
  fuLoadFiles();
}

let fuPageTimer = null;
function fuSetPage(value) {
  fuState.page = String(value || '').trim();
  fuRefreshHint();
  clearTimeout(fuPageTimer);
  fuPageTimer = setTimeout(fuLoadFiles, 300);
}

function fuDragOver(event) {
  event.preventDefault();
  document.getElementById('fu-drop')?.classList.add('is-over');
}

function fuDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  document.getElementById('fu-drop')?.classList.remove('is-over');
}

function fuDrop(event) {
  event.preventDefault();
  document.getElementById('fu-drop')?.classList.remove('is-over');
  fuAddFiles(event.dataTransfer?.files);
}

// Each file is queued with the folder it was dropped for, so switching page
// mid-upload doesn't move files still waiting.
function fuAddFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!fuState.page) {
    showToast('warning', 'Pick a page first', 'Choose which page these files belong to.');
    document.getElementById('fu-page')?.focus();
    return;
  }
  const maxMb = fuState.status?.max_file_mb || 50;
  for (const file of files) {
    const tooBig = file.size > maxMb * 1024 * 1024;
    fuState.queue.push({
      file,
      category: fuState.category,
      page: fuState.page,
      status: tooBig ? 'error' : 'waiting',
      progress: 0,
      error: tooBig ? `Larger than ${maxMb} MB` : '',
    });
  }
  renderFuQueue();
  fuRunQueue();
}

async function fuRunQueue() {
  if (fuState.uploading) return;
  fuState.uploading = true;
  let uploaded = 0;
  try {
    let item;
    while ((item = fuState.queue.find((q) => q.status === 'waiting'))) {
      item.status = 'uploading';
      renderFuQueue();
      try {
        await fuUploadOne(item);
        item.status = 'done';
        uploaded += 1;
        if (!fuState.pages.includes(item.page)) fuState.pages.push(item.page);
      } catch (error) {
        item.status = 'error';
        item.error = error.message || 'Upload failed';
      }
      renderFuQueue();
    }
  } finally {
    fuState.uploading = false;
  }
  if (uploaded) {
    showToast('success', 'Uploaded', `${uploaded} file${uploaded === 1 ? '' : 's'} saved.`);
    fuLoadFiles();
  }
}

// XMLHttpRequest rather than fetch: it reports upload progress.
function fuUploadOne(item) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ category: item.category, page: item.page });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getApiBase()}/uploads?${params}`);
    xhr.setRequestHeader('Authorization', `Bearer ${getAuthToken()}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
    xhr.setRequestHeader('X-File-Type', item.file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.round((event.loaded / event.total) * 100);
      const bar = document.querySelector(`[data-fu-index="${fuState.queue.indexOf(item)}"] .fu-bar span`);
      if (bar) bar.style.width = `${item.progress}%`;
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else if (xhr.status === 413) reject(new Error('File is too large'));
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(item.file);
  });
}

function fuFormatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderFuQueue() {
  const wrap = document.getElementById('fu-queue');
  if (!wrap) return;
  if (!fuState.queue.length) { wrap.innerHTML = ''; return; }
  const finished = fuState.queue.some((q) => q.status === 'done' || q.status === 'error');
  wrap.innerHTML = `
    <div class="fu-queue-head">
      <span>Uploads</span>
      ${finished && !fuState.uploading ? '<button class="btn btn-secondary btn-sm" onclick="fuClearQueue()">Clear finished</button>' : ''}
    </div>
    ${fuState.queue.map((q, index) => {
      const badge = q.status === 'done' ? '<span class="badge badge-success">Saved</span>'
        : q.status === 'error' ? `<span class="badge badge-danger" title="${escapeHtml(q.error)}">${escapeHtml(q.error)}</span>`
          : q.status === 'uploading' ? '<span class="badge badge-info">Uploading</span>'
            : '<span class="badge badge-gray">Waiting</span>';
      return `
      <div class="fu-item" data-fu-index="${index}">
        <div class="fu-item-main">
          <div class="fu-item-name">${escapeHtml(q.file.name)}</div>
          <div class="fu-item-meta">${escapeHtml(q.category)} / ${escapeHtml(q.page)} · ${fuFormatSize(q.file.size)}</div>
          ${q.status === 'uploading' ? `<div class="fu-bar"><span style="width:${q.progress}%"></span></div>` : ''}
        </div>
        ${badge}
      </div>`;
    }).join('')}`;
}

function fuClearQueue() {
  fuState.queue = fuState.queue.filter((q) => q.status === 'waiting' || q.status === 'uploading');
  renderFuQueue();
}

async function fuLoadFiles() {
  const wrap = document.getElementById('fu-files');
  if (!wrap) return;
  const params = new URLSearchParams({ category: fuState.category });
  if (fuState.page) params.set('page', fuState.page);
  const title = document.getElementById('fu-files-title');
  if (title) title.textContent = `Files · ${fuState.category}${fuState.page ? ` / ${fuState.page}` : ''}`;
  try {
    const data = await authorizedJsonRequest(`/uploads?${params}`);
    fuState.files = Array.isArray(data?.rows) ? data.rows : [];
  } catch (error) {
    wrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message || 'Could not load')}</p></div>`;
    return;
  }
  if (!fuState.files.length) {
    wrap.innerHTML = '<div class="empty-state"><p>Nothing uploaded here yet.</p></div>';
    return;
  }
  wrap.innerHTML = `
    <div class="fu-table-scroll"><table class="fu-table">
      <thead><tr><th>File</th><th>Page</th><th>Size</th><th>Uploaded by</th><th>When</th><th></th></tr></thead>
      <tbody>${fuState.files.map((r) => `
        <tr>
          <td><a href="#" onclick="event.preventDefault(); fuOpen(${Number(r.id)})">${escapeHtml(r.file_name)}</a></td>
          <td>${escapeHtml(r.page_name)}</td>
          <td>${fuFormatSize(r.size_bytes)}</td>
          <td>${escapeHtml(r.uploaded_by_name || '—')}</td>
          <td>${escapeHtml(fuFormatWhen(r.created_at))}</td>
          <td class="fu-row-actions">
            <button class="btn btn-secondary btn-sm" onclick="fuOpen(${Number(r.id)}, true)">Download</button>
            ${r.can_delete ? `<button class="btn btn-secondary btn-sm" onclick="fuDelete(${Number(r.id)})">Delete</button>` : ''}
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

function fuFormatWhen(value) {
  if (!value) return '';
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The bucket is private, so each view asks for a short-lived signed link. The
// tab opens first, inside the click, so pop-up blockers let it through.
async function fuOpen(id, download = false) {
  const tab = download ? null : window.open('', '_blank');
  try {
    const data = await authorizedJsonRequest(`/uploads/${id}/url${download ? '?download=1' : ''}`);
    if (tab) tab.location.href = data.url;
    else window.location.href = data.url;
  } catch (error) {
    tab?.close();
    showToast('error', 'Could not open file', error.message);
  }
}

async function fuDelete(id) {
  const row = fuState.files.find((f) => Number(f.id) === Number(id));
  if (!confirm(`Delete ${row?.file_name || 'this file'}? This cannot be undone.`)) return;
  try {
    await authorizedJsonRequest(`/uploads/${id}`, { method: 'DELETE' });
    showToast('success', 'File deleted', '');
    fuLoadFiles();
  } catch (error) {
    showToast('error', 'Could not delete', error.message);
  }
}

window.renderFileUploadsPage = renderFileUploadsPage;
window.initFileUploadsPage = initFileUploadsPage;
