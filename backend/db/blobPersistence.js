const fs = require('fs');
const { Readable } = require('stream');

const DEFAULT_BLOB_PATH = 'ynt-dashboard/ynt.db';

function isEnabled() {
  return Boolean(
    process.env.VERCEL
      && process.env.BLOB_READ_WRITE_TOKEN
      && process.env.SQLITE_BLOB_BACKUP !== 'false'
  );
}

function getBlobPath() {
  return process.env.SQLITE_BLOB_PATH || DEFAULT_BLOB_PATH;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of Readable.fromWeb(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function restoreDatabaseFromBlob(filename) {
  if (!isEnabled()) return false;

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

function createBackupScheduler(db, filename) {
  let timer = null;
  let running = false;
  let pending = false;

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

      const { put } = require('@vercel/blob');
      await put(getBlobPath(), body, {
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/vnd.sqlite3',
      });
      console.log(`[sqlite] Backed up database to Vercel Blob: ${getBlobPath()}`);
    } catch (error) {
      console.error(`[sqlite] Blob backup failed: ${error.message}`);
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
