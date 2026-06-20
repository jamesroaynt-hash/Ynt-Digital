const { DatabaseSync } = require('node:sqlite');

function normalizeSqlForPostgres(sql) {
  let index = 0;
  return String(sql)
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/order_date\s*>=\s*date\('now','-7 days'\)/gi, "order_date::date >= CURRENT_DATE - INTERVAL '7 days'")
    .replace(/date\('now'\)/gi, 'CURRENT_DATE')
    .replace(/time\('now'\)/gi, 'CURRENT_TIME')
    .replace(/date\('now','-7 days'\)/gi, "CURRENT_DATE - INTERVAL '7 days'")
    .replace(/strftime\('%m'\s*,\s*order_date\)/gi, "TO_CHAR(order_date::date, 'MM')")
    .replace(/strftime\('%Y'\s*,\s*order_date\)/gi, "TO_CHAR(order_date::date, 'YYYY')")
    .replace(/strftime\('%Y-%m'\s*,\s*order_date\)/gi, "TO_CHAR(order_date::date, 'YYYY-MM')")
    .replace(/strftime\('%Y-%m'\s*,\s*'now'\)/gi, "TO_CHAR(CURRENT_DATE, 'YYYY-MM')")
    .replace(/COALESCE\(([^,]+),\s*""\)/g, "COALESCE($1, '')")
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/\?/g, () => `$${++index}`);
}

class SqliteClient {
  constructor(filename) {
    this.type = 'sqlite';
    this.db = new DatabaseSync(filename);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  pragma(statement) {
    return this.db.exec(`PRAGMA ${statement}`);
  }

  close() {
    return this.db.close();
  }
}

class PostgresStatement {
  constructor(pool, sql) {
    this.pool = pool;
    this.sql = normalizeSqlForPostgres(sql);
  }

  async all(...params) {
    const result = await this.pool.query(this.sql, params);
    return result.rows;
  }

  async get(...params) {
    const result = await this.pool.query(this.sql, params);
    return result.rows[0] || null;
  }

  async run(...params) {
    const wantsReturning = /\bINSERT\b/i.test(this.sql) && !/\bRETURNING\b/i.test(this.sql);
    const sql = wantsReturning ? `${this.sql} RETURNING id` : this.sql;
    let result;
    try {
      result = await this.pool.query(sql, params);
    } catch (err) {
      // Some tables are keyed by a natural primary key and have no `id` column
      // (e.g. rts_page_sku keyed by page_name). For those, `RETURNING id` fails
      // with undefined_column (42703); retry the original statement so upserts
      // into id-less tables still work.
      if (wantsReturning && err && err.code === '42703') {
        result = await this.pool.query(this.sql, params);
      } else {
        throw err;
      }
    }
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id || 0,
    };
  }
}

class PostgresClient {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.type = 'postgres';
    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  }

  async exec(sql) {
    const normalized = normalizeSqlForPostgres(sql);
    return this.pool.query(normalized);
  }

  prepare(sql) {
    return new PostgresStatement(this.pool, sql);
  }

  async pragma() {
    return null;
  }

  async close() {
    return this.pool.end();
  }
}

function createDatabaseClient(options = {}) {
  if (process.env.DATABASE_URL) {
    return new PostgresClient(process.env.DATABASE_URL);
  }
  return new SqliteClient(options.filename);
}

module.exports = SqliteClient;
module.exports.SqliteClient = SqliteClient;
module.exports.PostgresClient = PostgresClient;
module.exports.createDatabaseClient = createDatabaseClient;
module.exports.normalizeSqlForPostgres = normalizeSqlForPostgres;
