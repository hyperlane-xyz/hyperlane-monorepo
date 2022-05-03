import { ContractMetricsConfig } from '.';

import { EnvironmentConfig } from '@abacus-network/deploy';
import { ChainName, MultiProvider } from '@abacus-network/sdk';

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
    getMultiProvider: () => Promise<MultiProvider<Networks>>;
  };

export enum ENVIRONMENTS_ENUM {
  Test = 'test',
  Dev = 'dev',
  Testnet = 'testnet',
}
export const ALL_ENVIRONMENTS = [
  ENVIRONMENTS_ENUM.Test,
  ENVIRONMENTS_ENUM.Dev,
  ENVIRONMENTS_ENUM.Testnet,
] as const;
type DeployEnvironmentTuple = typeof ALL_ENVIRONMENTS;
export type DeployEnvironment = DeployEnvironmentTuple[number];
