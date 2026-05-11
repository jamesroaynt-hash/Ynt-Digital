const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const { PostgresClient } = require('../db/client');
const { initializeDatabaseAsync } = require('../db/init');

const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '../db/ynt.db');
const sourceDatabaseUrl = process.env.BACKUP_SOURCE_DATABASE_URL || process.env.DATABASE_URL || '';
const backupDatabaseUrl = process.env.RAILWAY_BACKUP_DATABASE_URL || process.env.BACKUP_DATABASE_URL || '';

function describeConnectionUrl(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.username ? '<user>' : ''}${url.username ? ':<password>@' : ''}${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '<invalid database URL>';
  }
}

function validatePostgresUrl(name, connectionString) {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error(`${name} must start with postgresql:// or postgres://`);
    }
  } catch (error) {
    console.error(`${name} is not a valid Postgres connection string: ${error.message}`);
    process.exit(1);
  }
}

if (!backupDatabaseUrl) {
  console.error('RAILWAY_BACKUP_DATABASE_URL is required. Set it to the separate Railway Postgres backup connection string.');
  process.exit(1);
}

validatePostgresUrl('RAILWAY_BACKUP_DATABASE_URL', backupDatabaseUrl);
if (sourceDatabaseUrl) {
  validatePostgresUrl('BACKUP_SOURCE_DATABASE_URL or DATABASE_URL', sourceDatabaseUrl);
}

if (sourceDatabaseUrl && sourceDatabaseUrl === backupDatabaseUrl) {
  console.error('Backup cancelled: source database URL and backup database URL are the same.');
  process.exit(1);
}

const generatedColumns = {
  expenses: new Set(['total_amt']),
};

const preferredTableOrder = [
  'users',
  'attendance_records',
  'cash_advances',
  'leave_requests',
  'inventory',
  'orders',
  'expenses',
  'daily_pickups',
  'scan_records',
  'integration_settings',
  'integration_sync_runs',
  'integration_source_links',
  'integration_raw_records',
  'inventory_logs',
  'pos_shops',
  'pos_warehouses',
  'pos_orders',
  'pos_products',
  'pos_customers',
  'pos_users',
  'pos_transactions',
  'pos_inventory_histories',
];

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function sortTables(tables) {
  const priority = new Map(preferredTableOrder.map((table, index) => [table, index]));
  return tables.sort((left, right) => {
    const leftPriority = priority.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.localeCompare(right);
  });
}

function filterWritableColumns(table, columns) {
  const ignored = generatedColumns[table] || new Set();
  return columns.filter((column) => !ignored.has(column));
}

async function resetSequence(pool, table) {
  const idColumn = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = 'id'
  `, [table]);

  if (!idColumn.rowCount) return;

  await pool.query(`
    SELECT setval(
      pg_get_serial_sequence($1, 'id'),
      COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1),
      (SELECT COUNT(*) > 0 FROM ${quoteIdent(table)})
    )
  `, [table]);
}

async function getPostgresTables(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return sortTables(result.rows.map((row) => row.table_name));
}

async function getPostgresColumns(pool, table) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return filterWritableColumns(table, result.rows.map((row) => row.column_name));
}

function createSqliteSource(filename) {
  const sqlite = new DatabaseSync(filename);

  return {
    label: `SQLite at ${filename}`,
    async getTables() {
      const rows = sqlite.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all();
      return sortTables(rows.map((row) => row.name));
    },
    async getColumns(table) {
      const rows = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
      return filterWritableColumns(table, rows.map((row) => row.name));
    },
    async getRows(table, columns) {
      if (!columns.length) return [];
      return sqlite.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`).all();
    },
    async close() {
      sqlite.close();
    },
  };
}

function createPostgresSource(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  return {
    label: 'Postgres from BACKUP_SOURCE_DATABASE_URL or DATABASE_URL',
    async getTables() {
      return getPostgresTables(pool);
    },
    async getColumns(table) {
      return getPostgresColumns(pool, table);
    },
    async getRows(table, columns) {
      if (!columns.length) return [];
      const result = await pool.query(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`);
      return result.rows;
    },
    async close() {
      await pool.end();
    },
  };
}

async function truncateBackupTables(pool, tables) {
  if (!tables.length) return;
  await pool.query(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
}

async function copyTable(pool, source, table, targetColumns) {
  const sourceColumns = new Set(await source.getColumns(table));
  const columns = targetColumns.filter((column) => sourceColumns.has(column));
  if (!columns.length) return 0;

  const rows = await source.getRows(table, columns);
  if (!rows.length) {
    await resetSequence(pool, table);
    return 0;
  }

  const columnList = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})`;

  for (const row of rows) {
    await pool.query(sql, columns.map((column) => row[column]));
  }

  await resetSequence(pool, table);
  return rows.length;
}

async function main() {
  const source = sourceDatabaseUrl
    ? createPostgresSource(sourceDatabaseUrl)
    : createSqliteSource(sqlitePath);

  const backupClient = new PostgresClient(backupDatabaseUrl);
  const backupPool = backupClient.pool;

  try {
    console.log(`Source: ${source.label}`);
    console.log(`Target: Railway backup Postgres at ${describeConnectionUrl(backupDatabaseUrl)}`);

    await initializeDatabaseAsync(backupClient);
    const sourceTables = new Set(await source.getTables());
    const targetTables = await getPostgresTables(backupPool);
    const tablesToCopy = targetTables.filter((table) => sourceTables.has(table));

    await backupPool.query('BEGIN');
    try {
      await truncateBackupTables(backupPool, targetTables);

      for (const table of tablesToCopy) {
        const targetColumns = await getPostgresColumns(backupPool, table);
        const count = await copyTable(backupPool, source, table, targetColumns);
        console.log(`${table}: ${count} row(s) backed up`);
      }

      await backupPool.query('COMMIT');
    } catch (error) {
      await backupPool.query('ROLLBACK');
      throw error;
    }
  } finally {
    await source.close();
    await backupClient.close();
  }
}

main().catch((error) => {
  if (error.code === 'ENOTFOUND') {
    console.error(`Could not resolve database host "${error.hostname}".`);
    console.error('If you are running this from your local PC, use Railway Postgres public TCP/proxy URL, not Railway private/internal service variables.');
  }
  console.error(error.stack || error.message);
  process.exit(1);
});
