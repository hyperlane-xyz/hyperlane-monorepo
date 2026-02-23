import type { SqlAdapter } from './SqlAdapter.js';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    error TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS inflight_messages (
    message_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL,
    execution_type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    action_fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS action_attempts (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_hash TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (action_id) REFERENCES actions(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS tx_links (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL,
    tx_hash TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (action_id) REFERENCES actions(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS planner_transcript (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    llm_provider TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS reconciliations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );`,
  `CREATE TABLE IF NOT EXISTS runlog (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );`,
];

export async function migrate(sql: SqlAdapter): Promise<void> {
  for (const statement of MIGRATIONS) {
    await sql.exec(statement);
  }
}
