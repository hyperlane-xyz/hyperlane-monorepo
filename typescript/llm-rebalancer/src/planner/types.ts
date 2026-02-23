import type { LoopContext, PlannerOutput } from '../types.js';

export interface PlannerClient {
  provider: 'codex' | 'claude';
  model: string;
  plan(context: LoopContext): Promise<{ prompt: string; output: PlannerOutput }>;
}
