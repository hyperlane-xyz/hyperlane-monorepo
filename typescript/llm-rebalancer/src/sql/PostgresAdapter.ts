import type { Pool, QueryResult } from 'pg';

import type { SqlAdapter, SqlParams, SqlRow } from './SqlAdapter.js';

interface PgLike {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<QueryResult>;
  end?: () => Promise<void>;
}

export class PostgresAdapter implements SqlAdapter {
  constructor(private readonly client: PgLike) {}

  static async fromConnectionString(connectionString: string): Promise<PostgresAdapter> {
    const { Pool: PgPool } = (await import('pg')) as { Pool: typeof Pool };
    const pool = new PgPool({ connectionString });
    return new PostgresAdapter(pool);
  }

  async query<T extends SqlRow = SqlRow>(
    sql: string,
    params: SqlParams = [],
  ): Promise<T[]> {
    const result = await this.client.query(sql, [...params]);
    return result.rows as T[];
  }

  async exec(sql: string, params: SqlParams = []): Promise<void> {
    await this.client.query(sql, [...params]);
  }

  async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
    await this.exec('BEGIN');
    try {
      const result = await fn(this);
      await this.exec('COMMIT');
      return result;
    } catch (error) {
      await this.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.client.end) {
      await this.client.end();
    }
  }
}
