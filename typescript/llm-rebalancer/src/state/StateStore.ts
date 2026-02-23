import { createHash, randomUUID } from 'node:crypto';

import type {
  ActionExecutionResult,
  InflightMessage,
  Observation,
  PlannedAction,
  PlannerOutput,
  PriorContext,
} from '../types.js';
import type { SqlAdapter } from '../sql/SqlAdapter.js';
import { migrate } from '../sql/migrations.js';

interface JsonRecord {
  [key: string]: unknown;
}

export class StateStore {
  constructor(private readonly sql: SqlAdapter) {}

  async initialize(): Promise<void> {
    await migrate(this.sql);
  }

  static configHash(config: unknown): string {
    return createHash('sha256').update(JSON.stringify(config)).digest('hex');
  }

  async startRun(config: unknown): Promise<string> {
    const id = randomUUID();
    await this.sql.exec(
      `INSERT INTO runs (id, started_at, status, config_hash) VALUES ($1, $2, $3, $4)`,
      [id, Date.now(), 'in_progress', StateStore.configHash(config)],
    );
    return id;
  }

  async finishRun(runId: string, status: 'success' | 'failed', error?: string): Promise<void> {
    await this.sql.exec(
      `UPDATE runs SET ended_at = $1, status = $2, error = $3 WHERE id = $4`,
      [Date.now(), status, error ?? null, runId],
    );
  }

  async saveObservation(runId: string, observation: Observation): Promise<void> {
    await this.sql.exec(
      `INSERT INTO observations (id, run_id, observed_at, payload_json) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), runId, observation.observedAt, JSON.stringify(observation)],
    );
  }

  async replaceInflight(runId: string, inflight: InflightMessage[]): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.exec(`DELETE FROM inflight_messages`);
      for (const msg of inflight) {
        await tx.exec(
          `INSERT INTO inflight_messages (message_id, run_id, source, payload_json, last_seen_at) VALUES ($1, $2, $3, $4, $5)`,
          [msg.messageId, runId, msg.source, JSON.stringify(msg), Date.now()],
        );
      }
    });
  }

  async getPriorContext(limit: number = 50): Promise<PriorContext> {
    const [openIntents, openActions, recentReconciliations, recentPlannerTranscripts] =
      await Promise.all([
        this.sql.query<{ payload_json: string }>(
          `SELECT payload_json FROM intents WHERE status IN ('open', 'in_progress') ORDER BY updated_at DESC LIMIT $1`,
          [limit],
        ),
        this.sql.query<{ payload_json: string }>(
          `SELECT payload_json FROM actions WHERE status IN ('open', 'in_progress', 'submitted') ORDER BY updated_at DESC LIMIT $1`,
          [limit],
        ),
        this.sql.query<{ payload_json: string }>(
          `SELECT payload_json FROM reconciliations ORDER BY created_at DESC LIMIT $1`,
          [limit],
        ),
        this.sql.query<{ llm_provider: string; llm_model: string; created_at: number }>(
          `SELECT llm_provider, llm_model, created_at FROM planner_transcript ORDER BY created_at DESC LIMIT $1`,
          [limit],
        ),
      ]);

    return {
      openIntents: openIntents.map((r) => JSON.parse(r.payload_json) as JsonRecord),
      openActions: openActions.map((r) => JSON.parse(r.payload_json) as JsonRecord),
      recentReconciliations: recentReconciliations.map((r) =>
        JSON.parse(r.payload_json) as JsonRecord,
      ),
      recentPlannerTranscripts: recentPlannerTranscripts.map((r) => ({
        provider: r.llm_provider,
        model: r.llm_model,
        createdAt: r.created_at,
      })),
    };
  }

  async upsertPlannedAction(runId: string, action: PlannedAction): Promise<{ intentId: string; actionId: string }> {
    const existing = await this.sql.query<{ id: string; intent_id: string }>(
      `SELECT id, intent_id FROM actions WHERE action_fingerprint = $1`,
      [action.actionFingerprint],
    );
    if (existing.length > 0) {
      return { intentId: existing[0].intent_id, actionId: existing[0].id };
    }

    const intentId = randomUUID();
    const actionId = randomUUID();
    const now = Date.now();

    await this.sql.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO intents (id, route_id, execution_type, status, payload_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [intentId, action.routeId, action.executionType, 'open', JSON.stringify(action), now, now],
      );

      await tx.exec(
        `INSERT INTO actions (id, intent_id, action_fingerprint, status, payload_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [actionId, intentId, action.actionFingerprint, 'open', JSON.stringify(action), now, now],
      );

      await tx.exec(
        `INSERT INTO runlog (id, run_id, stage, message, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), runId, 'planning', 'planned_action_persisted', JSON.stringify(action), now],
      );
    });

    return { intentId, actionId };
  }

  async recordPlannerTranscript(
    runId: string,
    provider: string,
    model: string,
    prompt: string,
    output: PlannerOutput,
  ): Promise<void> {
    await this.sql.exec(
      `INSERT INTO planner_transcript (id, run_id, llm_provider, llm_model, prompt, response, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        runId,
        provider,
        model,
        this.truncate(prompt),
        this.truncate(JSON.stringify(output)),
        Date.now(),
      ],
    );
  }

  private truncate(value: string, maxLength = 200_000): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  }

  async recordActionAttempt(
    actionId: string,
    result: ActionExecutionResult,
  ): Promise<void> {
    const now = Date.now();
    await this.sql.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO action_attempts (id, action_id, status, tx_hash, error, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          actionId,
          result.success ? 'success' : 'failed',
          result.txHash ?? null,
          result.error ?? null,
          now,
        ],
      );

      await tx.exec(`UPDATE actions SET status = $1, updated_at = $2 WHERE id = $3`, [
        result.success ? 'submitted' : 'failed',
        now,
        actionId,
      ]);

      if (result.txHash || result.messageId) {
        await tx.exec(
          `INSERT INTO tx_links (id, action_id, tx_hash, message_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), actionId, result.txHash ?? null, result.messageId ?? null, now],
        );
      }
    });
  }

  async saveReconciliation(runId: string, payload: unknown): Promise<void> {
    await this.sql.exec(
      `INSERT INTO reconciliations (id, run_id, payload_json, created_at) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), runId, JSON.stringify(payload), Date.now()],
    );
  }

  async appendRunLog(
    runId: string,
    stage: string,
    message: string,
    payload?: unknown,
  ): Promise<void> {
    await this.sql.exec(
      `INSERT INTO runlog (id, run_id, stage, message, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        runId,
        stage,
        message,
        payload ? JSON.stringify(payload) : null,
        Date.now(),
      ],
    );
  }

  async readRunLog(runId: string): Promise<Array<{ stage: string; message: string; payload: unknown; createdAt: number }>> {
    const rows = await this.sql.query<{ stage: string; message: string; payload_json: string | null; created_at: number }>(
      `SELECT stage, message, payload_json, created_at FROM runlog WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return rows.map((r) => ({
      stage: r.stage,
      message: r.message,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      createdAt: r.created_at,
    }));
  }

  async markReconciled(actionFingerprint: string): Promise<void> {
    await this.sql.exec(
      `UPDATE actions SET status = $1, updated_at = $2 WHERE action_fingerprint = $3`,
      ['delivered', Date.now(), actionFingerprint],
    );
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
