// Copies every File Uploads file from the Supabase Storage bucket to a folder
// on this computer, keeping the bucket's folders:
//   <BACKUP_DIR>/Page Details/<page>/…   <BACKUP_DIR>/Customer Feedbacks/<page>/…
//
// Only new or changed files are downloaded, and nothing on this computer is
// ever deleted — a file deleted on the dashboard stays in the backup.
//
// Settings come from the environment or from backend/scripts/.env.uploads-backup
// (gitignored — it holds the service-role key):
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=...
//   BACKUP_DIR=D:\YNT Uploads Backup          (optional, this is the default)
//   SUPABASE_UPLOADS_BUCKET=dashboard-uploads (optional)
//
// Run: node backend/scripts/backup-uploads-local.js   (or backup-uploads.bat)

const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvFile(path.join(__dirname, '.env.uploads-backup'));

const BASE = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET = process.env.SUPABASE_UPLOADS_BUCKET || 'dashboard-uploads';
const BACKUP_DIR = process.env.BACKUP_DIR || 'D:\\YNT Uploads Backup';
const PAGE_SIZE = 1000;

const headers = { Authorization: `Bearer ${KEY}`, apikey: KEY };
const encodePath = (key) => key.split('/').map(encodeURIComponent).join('/');

// Storage lists one folder level at a time; entries without an id are folders.
async function listFolder(prefix) {
  const entries = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(`${BASE}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`List "${prefix || '/'}" failed (${response.status}): ${data?.message || data?.error || ''}`);
    entries.push(...data);
    if (data.length < PAGE_SIZE) return entries;
  }
}

async function* walk(prefix = '') {
  for (const entry of await listFolder(prefix)) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id) yield { key, size: Number(entry.metadata?.size ?? -1) };
    else yield* walk(key);
  }
}

async function download(key, target) {
  const response = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${encodePath(key)}`, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const temp = `${target}.part`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, target);
}

async function main() {
  if (!BASE || !KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Put them in backend/scripts/.env.uploads-backup.');
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  for await (const file of walk()) {
    const target = path.join(BACKUP_DIR, ...file.key.split('/'));
    if (fs.existsSync(target) && (file.size < 0 || fs.statSync(target).size === file.size)) {
      skipped += 1;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await download(file.key, target);
      copied += 1;
      console.log(`copied  ${file.key}`);
    } catch (error) {
      failed += 1;
      console.error(`FAILED  ${file.key}: ${error.message}`);
    }
  }
  const line = `${new Date().toISOString()}  copied ${copied}, already had ${skipped}, failed ${failed}`;
  console.log(line);
  fs.appendFileSync(path.join(BACKUP_DIR, 'backup-log.txt'), `${line}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
