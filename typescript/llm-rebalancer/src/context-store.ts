/**
 * Context persistence for LLM rebalancer cycles.
 *
 * The LLM writes a context summary at the end of each cycle,
 * which is injected into the next cycle's system prompt.
 */

import Database from 'better-sqlite3';

export interface ContextStore {
  get(routeId: string): Promise<string | null>;
  set(routeId: string, summary: string): Promise<void>;
  clear(routeId: string): Promise<void>;
}

/** In-memory implementation for simulation. */
export class InMemoryContextStore implements ContextStore {
  private store = new Map<string, string>();

  async get(routeId: string): Promise<string | null> {
    return this.store.get(routeId) ?? null;
  }

  async set(routeId: string, summary: string): Promise<void> {
    this.store.set(routeId, summary);
  }

  async clear(routeId: string): Promise<void> {
    this.store.delete(routeId);
  }
}

/** SQLite-backed implementation for production. Persists across restarts. */
export class SqliteContextStore implements ContextStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context (
        route_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_log_route
        ON context_log (route_id, created_at);
    `);
  }

  async get(routeId: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT summary FROM context WHERE route_id = ?')
      .get(routeId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  async set(routeId: string, summary: string): Promise<void> {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO context (route_id, summary, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(route_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
        )
        .run(routeId, summary, now);
      this.db
        .prepare(
          'INSERT INTO context_log (route_id, summary, created_at) VALUES (?, ?, ?)',
        )
        .run(routeId, summary, now);
    })();
  }

  async clear(routeId: string): Promise<void> {
    this.db.prepare('DELETE FROM context WHERE route_id = ?').run(routeId);
  }

  close(): void {
    this.db.close();
  }
}
