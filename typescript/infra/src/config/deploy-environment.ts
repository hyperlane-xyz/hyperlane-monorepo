import type { ChainName } from '@hyperlane-xyz/sdk';

const deployEnvironments = ['test', 'testnet4', 'mainnet3'] as const;

export type DeployEnvironment = (typeof deployEnvironments)[number];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  string,
  ChainName
>;
export enum AgentEnvironment {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}
export const envNameToAgentEnv: Record<DeployEnvironment, AgentEnvironment> = {
  test: AgentEnvironment.Testnet,
  testnet4: AgentEnvironment.Testnet,
  mainnet3: AgentEnvironment.Mainnet,
};

export function assertEnvironment(env: string): DeployEnvironment {
  if ((deployEnvironments as readonly string[]).includes(env)) {
    return env as DeployEnvironment;
  }
  throw new Error(
    `Invalid environment ${env}, must be one of ${deployEnvironments.join(', ')}`,
  );
}
