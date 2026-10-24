// Supabase Storage for the File Uploads page, through its REST API with the
// service-role key (the backend's Postgres connection can't move files).
//
// The bucket is private: nothing in it is reachable without a short-lived
// signed URL the backend hands out per view. It is created on first use, so
// there is no dashboard setup beyond the two env vars.

const BUCKET = process.env.SUPABASE_UPLOADS_BUCKET || 'dashboard-uploads';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function baseUrl() {
  return String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}

function configured() {
  return Boolean(baseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

// Each path segment is URL-encoded on its own so the slashes stay folders.
function objectUrl(kind, path) {
  return `${baseUrl()}/storage/v1/object/${kind}${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function storageRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: headers(options.headers) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Supabase Storage request failed (${response.status})`);
    error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status;
    error.storageStatus = String(data?.statusCode || response.status);
    throw error;
  }
  return data;
}

let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  try {
    await storageRequest(`${baseUrl()}/storage/v1/bucket/${BUCKET}`);
  } catch (error) {
    if (error.statusCode !== 404 && error.storageStatus !== '404' && error.statusCode !== 400) throw error;
    await storageRequest(`${baseUrl()}/storage/v1/bucket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE_BYTES }),
    });
  }
  bucketReady = true;
}

async function uploadObject(path, buffer, mimeType) {
  await ensureBucket();
  return storageRequest(objectUrl('', path), {
    method: 'POST',
    headers: { 'Content-Type': mimeType || 'application/octet-stream', 'x-upsert': 'false' },
    body: buffer,
  });
}

async function signedUrl(path, { expiresIn = 600, download = false } = {}) {
  const data = await storageRequest(objectUrl('sign/', path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  const url = `${baseUrl()}/storage/v1${data.signedURL}`;
  return download ? `${url}&download=` : url;
}

// Several signed URLs in one request (thumbnails for a whole list). Returns a
// Map of path → URL; a path Supabase couldn't sign is simply left out.
async function signedUrls(paths, { expiresIn = 3600 } = {}) {
  const result = new Map();
  if (!paths.length) return result;
  const data = await storageRequest(`${baseUrl()}/storage/v1/object/sign/${BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn, paths }),
  });
  for (const item of Array.isArray(data) ? data : []) {
    if (item?.path && item.signedURL) result.set(item.path, `${baseUrl()}/storage/v1${item.signedURL}`);
  }
  return result;
}

async function removeObject(path) {
  return storageRequest(`${baseUrl()}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  });
}

module.exports = { BUCKET, MAX_FILE_BYTES, configured, uploadObject, signedUrl, signedUrls, removeObject };
