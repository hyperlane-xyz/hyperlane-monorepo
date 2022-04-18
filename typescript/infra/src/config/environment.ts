import { EnvironmentConfig } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { ContractMetricsConfig } from '.';
import { CoreConfig } from '../core';
import { GovernanceConfig } from '../governance';
import { AgentConfig } from './agent';
import { InfrastructureConfig } from './infrastructure';

export type CoreEnvironmentConfig<Networks extends ChainName> =
  EnvironmentConfig<Networks> & {
    agent: AgentConfig;
    core: CoreConfig<Networks>;
    governance: GovernanceConfig<Networks>;
    metrics: ContractMetricsConfig;
    infra: InfrastructureConfig;
  };

export const ALL_ENVIRONMENTS = ['test'] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
