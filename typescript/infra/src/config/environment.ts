import { EnvironmentConfig } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { ContractMetricsConfig } from '.';
import { CoreConfig } from '../core';
import { GovernanceConfig } from '../governance';
import { AgentConfig } from './agent';
import { InfrastructureConfig } from './infrastructure';

export type CoreEnvironmentConfig<Networks extends ChainName> =
  EnvironmentConfig<Networks> & {
    agent: AgentConfig<Networks>;
    core: CoreConfig<Networks>;
    governance: GovernanceConfig<Networks>;
    metrics: ContractMetricsConfig;
    infra: InfrastructureConfig;
  };

export enum ENVIRONMENTS_ENUM {
  Test = 'test',
  Dev = 'dev',
}
export const ALL_ENVIRONMENTS = [
  ENVIRONMENTS_ENUM.Test,
  ENVIRONMENTS_ENUM.Dev,
] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
