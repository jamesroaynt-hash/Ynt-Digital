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
  let pending = false;

  async function uploadBackupToR2(body) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = getR2Key();

    await createR2Client().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/vnd.sqlite3',
    }));
    console.log(`[sqlite] Backed up database to Cloudflare R2: ${process.env.R2_BUCKET}/${key}`);
  }

  async function uploadBackupToVercelBlob(body) {
    const { put } = require('@vercel/blob');

    await put(getBlobPath(), body, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/vnd.sqlite3',
    });
    console.log(`[sqlite] Backed up database to Vercel Blob: ${getBlobPath()}`);
  }

  async function uploadBackup() {
    if (!isEnabled()) return;
    if (db.type !== 'sqlite') return;
    if (running) {
      pending = true;
      return;
    }

    running = true;
    try {
      db.pragma('wal_checkpoint(FULL)');
      const body = fs.readFileSync(filename);
      if (!body.length) return;

      if (isR2Enabled()) {
        await uploadBackupToR2(body);
      } else {
        await uploadBackupToVercelBlob(body);
      }
    } catch (error) {
      console.error(`[sqlite] Cloud backup failed: ${error.message}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule(delayMs = 750) {
    if (!isEnabled()) return;
    clearTimeout(timer);
    timer = setTimeout(uploadBackup, delayMs);
  }

  return { schedule, uploadBackup };
}

module.exports = {
  isEnabled,
  restoreDatabaseFromBlob,
  createBackupScheduler,
};
