const fs = require('fs');
const { Readable } = require('stream');

const DEFAULT_BLOB_PATH = 'ynt-dashboard/ynt.db';
const DEFAULT_R2_KEY = 'ynt-dashboard/ynt.db';

function isVercelBlobEnabled() {
  return Boolean(
    process.env.VERCEL
      && process.env.BLOB_READ_WRITE_TOKEN
      && process.env.SQLITE_BLOB_BACKUP !== 'false'
  );
}

function isR2Enabled() {
  return Boolean(
    process.env.R2_ACCOUNT_ID
      && process.env.R2_ACCESS_KEY_ID
      && process.env.R2_SECRET_ACCESS_KEY
      && process.env.R2_BUCKET
      && process.env.R2_SQLITE_BACKUP !== 'false'
  );
}

function isEnabled() {
  return isR2Enabled() || isVercelBlobEnabled();
}

function getBlobPath() {
  return process.env.SQLITE_BLOB_PATH || DEFAULT_BLOB_PATH;
}

function getR2Key() {
  return process.env.R2_SQLITE_BACKUP_KEY || DEFAULT_R2_KEY;
}

function createR2Client() {
  const { S3Client } = require('@aws-sdk/client-s3');

  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function streamToBuffer(stream) {
  if (stream?.getReader) {
    const chunks = [];
    for await (const chunk of Readable.fromWeb(stream)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function restoreDatabaseFromR2(filename) {
  if (!isR2Enabled()) return false;

  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const key = getR2Key();

  try {
    const result = await createR2Client().send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    if (!result?.Body) return false;

    const backup = await streamToBuffer(result.Body);
    if (!backup.length) return false;

    fs.writeFileSync(filename, backup);
    console.log(`[sqlite] Restored database from Cloudflare R2: ${process.env.R2_BUCKET}/${key}`);
    return true;
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      console.log(`[sqlite] No R2 backup found at ${process.env.R2_BUCKET}/${key}; starting with local seed database.`);
      return false;
    }
    console.error(`[sqlite] R2 restore failed: ${error.message}`);
    return false;
  }
}

async function restoreDatabaseFromVercelBlob(filename) {
  if (!isVercelBlobEnabled()) return false;

  const { get } = require('@vercel/blob');
  const pathname = getBlobPath();

  try {
    const result = await get(pathname, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) {
      console.log(`[sqlite] No Blob backup found at ${pathname}; starting with local seed database.`);
      return false;
    }

    const backup = await streamToBuffer(result.stream);
    if (!backup.length) return false;

    fs.writeFileSync(filename, backup);
    console.log(`[sqlite] Restored database from Vercel Blob: ${pathname}`);
    return true;
  } catch (error) {
    if (error?.name === 'BlobNotFoundError') {
      console.log(`[sqlite] No Blob backup found at ${pathname}; starting with local seed database.`);
      return false;
    }
    console.error(`[sqlite] Blob restore failed: ${error.message}`);
    return false;
  }
}

async function restoreDatabaseFromBlob(filename) {
  if (isR2Enabled()) {
    return restoreDatabaseFromR2(filename);
  }

  return restoreDatabaseFromVercelBlob(filename);
}

function createBackupScheduler(db, filename) {
  let timer = null;
  let running = false;
  let dirty = false;   // writes happened since the last successful upload
  let lastRunAt = 0;   // ms timestamp of the last upload attempt

  // The whole SQLite file ships to R2/Blob on every backup, so backing up
  // per-write (the old 750ms debounce) re-uploaded the multi-MB DB back-to-back
  // under the Pancake webhook flood — the dominant Railway egress source. Cap it
  // to at most once per interval, and only when something actually changed.
  const MIN_INTERVAL_MS = Math.max(
    30 * 1000,
    Number(process.env.SQLITE_BACKUP_MIN_INTERVAL_MS || 15 * 60 * 1000)
  );

  // Volume mode: when the DB lives on a Railway persistent volume it survives
  // restarts on its own, so per-write uploads are pure egress waste. Set
  // SQLITE_BACKUP_ON_WRITE=false to retire the write-triggered path and rely
  // only on a periodic disaster-recovery snapshot (SQLITE_BACKUP_INTERVAL_MS,
  // e.g. 86400000 for daily).
  const BACKUP_ON_WRITE = process.env.SQLITE_BACKUP_ON_WRITE !== 'false';
  const PERIODIC_INTERVAL_MS = Number(process.env.SQLITE_BACKUP_INTERVAL_MS || 0);

  function armTimer() {
    if (timer || running) return;
    const delay = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRunAt));
    timer = setTimeout(() => {
      timer = null;
      uploadBackup();
    }, delay);
  }

  async function uploadBackupToR2(dbFilename, size) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = getR2Key();

    await createR2Client().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: fs.createReadStream(dbFilename),
      ContentLength: size,
      ContentType: 'application/vnd.sqlite3',
    }));
    console.log(`[sqlite] Backed up database to Cloudflare R2: ${process.env.R2_BUCKET}/${key}`);
  }

  async function uploadBackupToVercelBlob(dbFilename) {
    const { put } = require('@vercel/blob');

    await put(getBlobPath(), fs.createReadStream(dbFilename), {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/vnd.sqlite3',
    });
    console.log(`[sqlite] Backed up database to Vercel Blob: ${getBlobPath()}`);
  }

  async function uploadBackup({ force = false } = {}) {
    if (!isEnabled()) return;
    if (db.type !== 'sqlite') return;
    if (running) return;
    if (!dirty && !force) return;

    running = true;
    dirty = false;
    lastRunAt = Date.now();
    try {
      db.pragma('wal_checkpoint(FULL)');
      const stat = fs.statSync(filename);
      if (!stat.size) return;

      if (isR2Enabled()) {
        await uploadBackupToR2(filename, stat.size);
      } else {
        await uploadBackupToVercelBlob(filename);
      }
    } catch (error) {
      dirty = true; // failed — retry on the next interval
      console.error(`[sqlite] Cloud backup failed: ${error.message}`);
    } finally {
      running = false;
      if (dirty) armTimer();
    }
  }

  // Mark the DB dirty and ensure a throttled upload is scheduled. Callers fire
  // this on every mutating request; the interval gate keeps egress bounded.
  // In volume mode (BACKUP_ON_WRITE=false) this is a no-op — periodic snapshots
  // handle durability instead.
  function schedule() {
    if (!isEnabled()) return;
    if (!BACKUP_ON_WRITE) return;
    dirty = true;
    armTimer();
  }

  // Fixed-cadence disaster-recovery snapshot, independent of write activity.
  // Returns the timer (unref'd) or null when not configured.
  function startPeriodicBackups() {
    if (!isEnabled() || !PERIODIC_INTERVAL_MS) return null;
    const intervalMs = Math.max(60 * 1000, PERIODIC_INTERVAL_MS);
    console.log(`[sqlite] Periodic R2/Blob snapshot every ${Math.round(intervalMs / 1000)}s.`);
    return setInterval(() => { uploadBackup({ force: true }); }, intervalMs).unref();
  }

  return { schedule, uploadBackup, startPeriodicBackups };
}

module.exports = {
  isEnabled,
  restoreDatabaseFromBlob,
  createBackupScheduler,
};
