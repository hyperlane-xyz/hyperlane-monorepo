/**
 * Context persistence for LLM rebalancer cycles.
 *
 * Replaces SQLite action log with LLM-authored prose summaries.
 * The LLM writes a context summary at the end of each cycle,
 * which is injected into the next cycle's system prompt.
 */

export interface ContextStore {
  get(routeId: string): Promise<string | null>;
  set(routeId: string, summary: string): Promise<void>;
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
}
