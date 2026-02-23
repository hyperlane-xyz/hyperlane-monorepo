import type { SqlAdapter } from '../sql/SqlAdapter.js';
import { StateStore } from '../state/StateStore.js';

export class DurableTools {
  constructor(
    private readonly sql: SqlAdapter,
    private readonly stateStore: StateStore,
  ) {}

  async dbRead(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.sql.query(query, params);
  }

  async dbWrite(statement: string, params: unknown[] = []): Promise<void> {
    await this.sql.exec(statement, params);
  }

  async runlogAppend(
    runId: string,
    stage: string,
    message: string,
    payload?: unknown,
  ): Promise<void> {
    await this.stateStore.appendRunLog(runId, stage, message, payload);
  }

  async runlogRead(
    runId: string,
  ): Promise<Array<{ stage: string; message: string; payload: unknown; createdAt: number }>> {
    return this.stateStore.readRunLog(runId);
  }
}
