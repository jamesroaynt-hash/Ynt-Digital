/* ═══════════════════════════════════════════════════════════
   FILE UPLOADS — drag files in, they're stored in Supabase Storage
   Folders are made by users (Page Details and Customer Feedbacks to start)
   and picked from one dropdown; inside each, a file is filed under
   Product Info or Product Feedback. A link can be saved there too.
   Backed by /api/uploads. Every signed-in user uploads and views; the
   uploader or an Administrator deletes. Anyone creates a folder; its
   creator or an Administrator renames it or deletes it once empty.
   Loaded before app.js; it leans on app.js globals (App, escapeHtml,
   authorizedJsonRequest, getApiBase, getAuthToken, showToast) read at
   call time.
   ═══════════════════════════════════════════════════════════ */

const fuState = {
  status: null,
  folders: [],
  category: 'Page Details',
  section: 'Product Info',
  queue: [],
  uploading: false,
  files: [],
};

function renderFileUploadsPage() {
  return `
  <div class="page-header">
    <div class="page-title">
      <h1>File Uploads</h1>
      <p>Pick a folder, then drop images and files into it.</p>
    </div>
  </div>
  <div id="fu-body"><div class="card"><div class="empty-state"><h3>Loading</h3></div></div></div>`;
}

async function initFileUploadsPage() {
  try {
    const status = await authorizedJsonRequest('/uploads/status');
    fuState.status = status;
    fuApplyFolders(status.folders);
  } catch (error) {
    const body = document.getElementById('fu-body');
    if (body) body.innerHTML = `<div class="card"><div class="empty-state"><h3>Could not load</h3><p>${escapeHtml(error.message || 'error')}</p></div></div>`;
    return;
  }
  renderFuBody();
  if (fuState.status.configured) fuLoadFiles();
}

function fuApplyFolders(folders) {
  fuState.folders = Array.isArray(folders) ? folders : [];
  if (!fuState.folders.some((f) => f.name === fuState.category)) {
    fuState.category = fuState.folders[0]?.name || '';
  }
}

function fuCurrentFolder() {
  return fuState.folders.find((f) => f.name === fuState.category) || null;
}

function renderFuFolders() {
  const wrap = document.getElementById('fu-folders');
  if (!wrap) return;
  const options = fuState.folders.length
    ? fuState.folders.map((f) =>
      `<option value="${Number(f.id)}" ${fuState.category === f.name ? 'selected' : ''}>${escapeHtml(f.name)} (${Number(f.file_count) || 0})</option>`).join('')
    : '<option value="">No folders yet</option>';
  const current = fuCurrentFolder();
  const manage = current?.can_manage ? `
      <button class="btn btn-secondary btn-sm" type="button" onclick="fuRenameFolder(${Number(current.id)})">Rename</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick="fuDeleteFolder(${Number(current.id)})">Delete</button>` : '';
  wrap.innerHTML = `
    <div class="fu-folder-row">
      <select class="form-control fu-folder-select" id="fu-folder" onchange="fuSetFolder(this.value)">${options}</select>
      <button class="btn btn-secondary btn-sm" type="button" onclick="fuToggleNewFolder(true)">+ New folder</button>
      ${manage}
    </div>
    <form class="fu-new-folder" id="fu-new-folder" hidden onsubmit="event.preventDefault(); fuCreateFolder();">
      <input class="form-control" id="fu-new-folder-name" maxlength="80" placeholder="Folder name, e.g. Product Photos" autocomplete="off">
      <button class="btn btn-primary btn-sm" type="submit">Create</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick="fuToggleNewFolder(false)">Cancel</button>
    </form>`;
}

function fuToggleNewFolder(open) {
  const form = document.getElementById('fu-new-folder');
  if (!form) return;
  form.hidden = !open;
  const input = document.getElementById('fu-new-folder-name');
  if (open) input?.focus();
  else if (input) input.value = '';
}

async function fuReloadFolders() {
  const data = await authorizedJsonRequest('/uploads/folders');
  fuApplyFolders(data?.folders);
  renderFuFolders();
  fuRefreshHint();
  fuLoadFiles();
}

async function fuCreateFolder() {
  const name = String(document.getElementById('fu-new-folder-name')?.value || '').trim();
  if (!name) { document.getElementById('fu-new-folder-name')?.focus(); return; }
  try {
    await authorizedJsonRequest('/uploads/folders', { method: 'POST', body: JSON.stringify({ name }) });
    fuState.category = name;
    showToast('success', 'Folder created', name);
    await fuReloadFolders();
  } catch (error) {
    showToast('error', 'Could not create folder', error.message);
  }
}

async function fuRenameFolder(id) {
  const folder = fuState.folders.find((f) => Number(f.id) === Number(id));
  if (!folder) return;
  const name = String(prompt('Rename folder', folder.name) || '').trim();
  if (!name || name === folder.name) return;
  try {
    await authorizedJsonRequest(`/uploads/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    fuState.category = name;
    showToast('success', 'Folder renamed', name);
    await fuReloadFolders();
  } catch (error) {
    showToast('error', 'Could not rename folder', error.message);
  }
}

async function fuDeleteFolder(id) {
  const folder = fuState.folders.find((f) => Number(f.id) === Number(id));
  if (!folder) return;
  if (folder.file_count > 0) {
    showToast('warning', 'Folder is not empty', `Delete its ${folder.file_count} file${folder.file_count === 1 ? '' : 's'} first.`);
    return;
  }
  if (!confirm(`Delete the folder "${folder.name}"?`)) return;
  try {
    await authorizedJsonRequest(`/uploads/folders/${id}`, { method: 'DELETE' });
    showToast('success', 'Folder deleted', folder.name);
    await fuReloadFolders();
  } catch (error) {
    showToast('error', 'Could not delete folder', error.message);
  }
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


  body.innerHTML = `
    <div class="card"><div class="card-body">
      <div class="fu-controls">
        <div class="form-group">
          <label class="form-label" for="fu-folder">Folder</label>
          <div id="fu-folders"></div>
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
      <form class="fu-link-row" onsubmit="event.preventDefault(); fuAddLink();">
        <input class="form-control fu-link-url" id="fu-link-url" type="url" placeholder="Or paste a link — https://…" autocomplete="off">
        <input class="form-control fu-link-name" id="fu-link-name" maxlength="250" placeholder="Name (optional)" autocomplete="off">
        <button class="btn btn-secondary btn-sm" type="submit">Add link</button>
      </form>
      <div id="fu-queue"></div>
    </div></div>
    <div class="card" style="margin-top:20px;">
      <div class="card-header">
        <div class="fu-files-head">
          <div class="card-title" id="fu-files-title">Files</div>
          <div class="fu-pills" id="fu-sections" role="group" aria-label="Category"></div>
        </div>
      </div>
      <div id="fu-files"><div class="empty-state"><p>Loading</p></div></div>
    </div>`;
  renderFuFolders();
  renderFuSections();
  renderFuQueue();
}

function fuSections() {
  return fuState.status?.sections || ['Product Info', 'Product Feedback'];
}

function renderFuSections() {
  const wrap = document.getElementById('fu-sections');
  if (!wrap) return;
  wrap.innerHTML = fuSections().map((name, index) =>
    `<button class="filter-pill ${fuState.section === name ? 'active' : ''}" type="button" onclick="fuSetSection(${index})">${escapeHtml(name)}</button>`).join('');
}

function fuSetSection(index) {
  const name = fuSections()[index];
  if (!name) return;
  fuState.section = name;
  renderFuSections();
  fuRefreshHint();
  fuLoadFiles();
}

function fuDropHint() {
  const max = fuState.status?.max_file_mb || 50;
  if (!fuState.category) return 'Create a folder first.';
  return `Goes to ${escapeHtml(fuState.category)} / ${escapeHtml(fuState.section)} — or click to choose. Up to ${max} MB each.`;
}

function fuRefreshHint() {
  const hint = document.getElementById('fu-drop-hint');
  if (hint) hint.innerHTML = fuDropHint();
}

function fuSetFolder(id) {
  const folder = fuState.folders.find((f) => Number(f.id) === Number(id));
  if (!folder) return;
  fuState.category = folder.name;
  renderFuFolders();
  fuRefreshHint();
  fuLoadFiles();
}

async function fuAddLink() {
  const urlInput = document.getElementById('fu-link-url');
  const nameInput = document.getElementById('fu-link-name');
  const url = String(urlInput?.value || '').trim();
  if (!fuState.category) {
    showToast('warning', 'Create a folder first', 'Use + New folder to make one.');
    return;
  }
  if (!url) { urlInput?.focus(); return; }
  try {
    await authorizedJsonRequest('/uploads/links', {
      method: 'POST',
      body: JSON.stringify({ category: fuState.category, section: fuState.section, url, name: String(nameInput?.value || '').trim() }),
    });
    if (urlInput) urlInput.value = '';
    if (nameInput) nameInput.value = '';
    showToast('success', 'Link saved', `${fuState.category} / ${fuState.section}`);
    fuReloadFolders().catch(() => fuLoadFiles());
  } catch (error) {
    showToast('error', 'Could not save link', error.message);
  }
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

// Each file is queued with the folder it was dropped for, so switching folder
// mid-upload doesn't move files still waiting.
function fuAddFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!fuState.category) {
    showToast('warning', 'Create a folder first', 'Use + New folder to make one.');
    return;
  }
  const maxMb = fuState.status?.max_file_mb || 50;
  for (const file of files) {
    const tooBig = file.size > maxMb * 1024 * 1024;
    fuState.queue.push({
      file,
      category: fuState.category,
      section: fuState.section,
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
    fuReloadFolders().catch(() => fuLoadFiles());
  }
}

// XMLHttpRequest rather than fetch: it reports upload progress.
function fuUploadOne(item) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ category: item.category, section: item.section });
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
          <div class="fu-item-meta">${escapeHtml(q.category)} / ${escapeHtml(q.section)} · ${fuFormatSize(q.file.size)}</div>
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
  if (!fuState.category) {
    wrap.innerHTML = '<div class="empty-state"><p>No folders yet. Use + New folder to make one.</p></div>';
    return;
  }
  // The Category buttons beside the title pick both where uploads go and
  // which files are listed.
  const params = new URLSearchParams({ category: fuState.category, page: fuState.section });
  const title = document.getElementById('fu-files-title');
  if (title) title.textContent = `Files · ${fuState.category}`;
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
    <div class="fu-grid">${fuState.files.map((r) => {
      // Laid out like a file explorer's large icons: picture, name under it.
      // Details show on hover; Download/Delete appear on hover or focus.
      const details = [r.file_name, r.page_name !== r.category ? r.page_name : '', r.link_url ? 'Link' : fuFormatSize(r.size_bytes),
        r.uploaded_by_name, fuFormatWhen(r.created_at)].filter(Boolean).join(' · ');
      const isVideo = String(r.mime_type || '').startsWith('video/');
      const open = r.link_url
        ? `href="${escapeHtml(r.link_url)}" target="_blank" rel="noopener noreferrer"`
        : `href="#" onclick="event.preventDefault(); fuOpen(${Number(r.id)})"`;
      const preview = r.thumb_url && isVideo
        ? `<video src="${escapeHtml(r.thumb_url)}#t=0.5" preload="metadata" muted playsinline></video><span class="fu-play" aria-hidden="true">▶</span>`
        : r.thumb_url
          ? `<img src="${escapeHtml(r.thumb_url)}" alt="" loading="lazy">`
          : `<span class="fu-icon" aria-hidden="true">${fuFileIcon(r)}</span>`;
      return `
      <div class="fu-tile" title="${escapeHtml(details)}">
        <a class="fu-tile-open" ${open}>
          <span class="fu-tile-preview">${preview}</span>
          <span class="fu-tile-name">${escapeHtml(r.file_name)}</span>
        </a>
        <div class="fu-tile-actions">
          ${r.link_url ? '' : `<button class="btn btn-secondary btn-sm" onclick="fuOpen(${Number(r.id)}, true)">Download</button>`}
          ${r.can_delete ? `<button class="btn btn-secondary btn-sm" onclick="fuDelete(${Number(r.id)})">Delete</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
}

// Big outline icon for anything without a picture: a link or a document
// labelled with its extension.
function fuFileIcon(r) {
  if (r.link_url) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1"/></svg>';
  }
  const ext = (String(r.file_name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase();
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg><b>${escapeHtml(ext)}</b>`;
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
    showToast('success', 'Deleted', '');
    fuReloadFolders().catch(() => fuLoadFiles());
  } catch (error) {
    showToast('error', 'Could not delete', error.message);
  }
}

window.renderFileUploadsPage = renderFileUploadsPage;
window.initFileUploadsPage = initFileUploadsPage;
