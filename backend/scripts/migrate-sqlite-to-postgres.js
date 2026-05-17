const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '../db/ynt.db');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is required. Set it to your Railway Postgres connection string.');
  process.exit(1);
}

const generatedColumns = {
  expenses: new Set(['total_amt']),
};

const preferredTableOrder = [
  'users',
  'inventory',
  'orders',
  'expenses',
  'daily_pickups',
  'scan_records',
  'integration_settings',
  'integration_sync_runs',
  'integration_source_links',
  'inventory_logs',
];

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function getTables(sqlite) {
  const tables = sqlite.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);

  const priority = new Map(preferredTableOrder.map((table, index) => [table, index]));
  return tables.sort((left, right) => {
    const leftPriority = priority.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.localeCompare(right);
  });
}

function getColumns(sqlite, table) {
  const ignored = generatedColumns[table] || new Set();
  return sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((row) => row.name)
    .filter((name) => !ignored.has(name));
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

async function migrateTable(pool, sqlite, table) {
  const columns = getColumns(sqlite, table);
  if (!columns.length) return 0;

  const rows = sqlite.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`).all();
  if (!rows.length) return 0;

  const columnList = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `
    INSERT INTO ${quoteIdent(table)} (${columnList})
    VALUES (${placeholders})
    ON CONFLICT DO NOTHING
  `;

  for (const row of rows) {
    await pool.query(sql, columns.map((column) => row[column]));
  }

  await resetSequence(pool, table);
  return rows.length;
}

async function main() {
  const sqlite = new DatabaseSync(sqlitePath);
  const pool = new Pool({
    connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    const tables = getTables(sqlite);
    for (const table of tables) {
      const count = await migrateTable(pool, sqlite, table);
      console.log(`${table}: ${count} row(s) copied`);
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
