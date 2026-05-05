const { DatabaseSync } = require('node:sqlite');

class SqliteClient {
  constructor(filename) {
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

module.exports = SqliteClient;
