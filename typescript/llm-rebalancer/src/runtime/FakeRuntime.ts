import type {
  AgentRuntime,
  SkillInvocation,
  SkillInvocationResult,
} from './types.js';

export type FakeSkillMap = Record<string, (input: unknown) => unknown | Promise<unknown>>;

export class FakeRuntime implements AgentRuntime {
  constructor(private readonly skills: FakeSkillMap) {}

  async invokeSkill(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const handler = this.skills[invocation.skillPath];
    if (!handler) {
      throw new Error(`No fake handler for skill ${invocation.skillPath}`);
    }

    const output = await handler(invocation.input);
    return {
      output,
      stdout: JSON.stringify(output),
      stderr: '',
    };
  }
}
