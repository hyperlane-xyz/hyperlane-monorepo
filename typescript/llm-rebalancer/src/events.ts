/**
 * Structured event types for observability.
 */

export type RebalancerAgentEvent =
  | { type: 'cycle_start'; timestamp: number }
  | { type: 'cycle_end'; timestamp: number; status: 'balanced' | 'pending' }
  | { type: 'tool_call'; timestamp: number; tool: string; args: unknown }
  | { type: 'tool_result'; timestamp: number; tool: string; result: string }
  | { type: 'text'; timestamp: number; text: string }
  | { type: 'error'; timestamp: number; error: string };
