/**
 * save_context tool — persists LLM-authored context summary between cycles.
 */

import { Type, type Static } from '@sinclair/typebox';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { ContextStore } from '../context-store.js';

const parameters = Type.Object({
  status: Type.Union([Type.Literal('balanced'), Type.Literal('pending')]),
  summary: Type.String({ description: 'Prose summary of current state and pending actions. Keep under 2000 chars.' }),
});

type Params = Static<typeof parameters>;

export function buildSaveContextTool(
  contextStore: ContextStore,
  routeId: string,
): ToolDefinition<typeof parameters> {
  return {
    name: 'save_context',
    label: 'Save Context',
    description:
      'Save a prose summary of the current rebalancing state for the next cycle. ' +
      'Call this at the END of every cycle. Status should be "balanced" if no pending actions remain, ' +
      '"pending" if transfers are inflight or you just initiated a rebalance.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      const summary = params.summary.slice(0, 4000);
      await contextStore.set(routeId, JSON.stringify({ status: params.status, summary }));
      const text = `Context saved (status: ${params.status}, ${summary.length} chars).`;
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  };
}
