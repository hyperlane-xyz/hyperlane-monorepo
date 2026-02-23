import { randomUUID } from 'node:crypto';

import type { ActionExecutionResult, PlannedAction, SkillProfile } from '../types.js';
import type { AgentRuntime } from '../runtime/types.js';

export class SkillActionExecutor {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly profile: SkillProfile,
  ) {}

  async execute(runId: string, action: PlannedAction): Promise<ActionExecutionResult> {
    const skillPath = this.skillForAction(action);
    const invocation = await this.runtime.invokeSkill({
      runId,
      skillPath,
      input: {
        action,
      },
    });

    const output = invocation.output as Record<string, unknown>;
    const txHash = typeof output.txHash === 'string' ? output.txHash : undefined;
    const messageId =
      typeof output.messageId === 'string' ? output.messageId : randomUUID();

    return {
      actionFingerprint: action.actionFingerprint,
      success: output.success !== false,
      txHash,
      messageId,
      error: typeof output.error === 'string' ? output.error : undefined,
    };
  }

  private skillForAction(action: PlannedAction): string {
    if (action.executionType === 'movableCollateral') {
      return this.profile.executeMovable;
    }

    if (action.bridge === 'lifi' || action.executionType === 'inventory') {
      return this.profile.executeInventoryLifi;
    }

    throw new Error(`Unsupported execution path: ${action.executionType}`);
  }
}
