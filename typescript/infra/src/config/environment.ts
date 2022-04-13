import { EnvironmentConfig } from '@abacus-network/deploy';
import { AgentConfig } from './agent';
import { CoreConfig } from '../core';
import { GovernanceConfig } from '../governance';
import { ContractMetricsConfig } from '.';
import { InfrastructureConfig } from './infrastructure';

export type CoreEnvironmentConfig = EnvironmentConfig & {
  agent: AgentConfig;
  core: CoreConfig;
  governance: GovernanceConfig;
  metrics: ContractMetricsConfig;
  infra: InfrastructureConfig;
};

export const ALL_ENVIRONMENTS = ['test'] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
