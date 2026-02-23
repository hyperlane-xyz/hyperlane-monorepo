export interface SkillInvocation {
  skillPath: string;
  input: unknown;
  runId: string;
}

export interface SkillInvocationResult {
  output: unknown;
  stdout: string;
  stderr: string;
}

export interface AgentRuntime {
  invokeSkill(invocation: SkillInvocation): Promise<SkillInvocationResult>;
}
