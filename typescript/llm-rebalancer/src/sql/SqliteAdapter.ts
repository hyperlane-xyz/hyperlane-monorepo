import { DatabaseSync } from 'node:sqlite';

import type { SqlAdapter, SqlParams, SqlRow } from './SqlAdapter.js';

export class SqliteAdapter implements SqlAdapter {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  async query<T extends SqlRow = SqlRow>(
    sql: string,
    params: SqlParams = [],
  ): Promise<T[]> {
    const stmt = this.db.prepare(this.normalizeSql(sql));
    return stmt.all(...(params as any[])) as T[];
  }

  async exec(sql: string, params: SqlParams = []): Promise<void> {
    const stmt = this.db.prepare(this.normalizeSql(sql));
    stmt.run(...(params as any[]));
  }

  async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN;');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private normalizeSql(sql: string): string {
    // Reuse postgres-style placeholders with SQLite.
    return sql.replace(/\$\d+/g, '?');
  }
}
