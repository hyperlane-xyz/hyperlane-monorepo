import { EnvironmentConfig } from '@abacus-network/deploy';
import { ChainMap, ChainName, MultiProvider } from '@abacus-network/sdk';

import { environments } from '../../config/environments';
import { CoreConfig } from '../core';
import { GovernanceConfig } from '../governance';

import { AgentConfig } from './agent';
import { InfrastructureConfig } from './infrastructure';

export const EnvironmentNames = Object.keys(environments);
export type DeployEnvironment = keyof typeof environments;
export type EnvironmentNetworks<E extends DeployEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreEnvironmentConfig<Networks extends ChainName> = {
  transactionConfigs: EnvironmentConfig<Networks>;
  agent: AgentConfig<Networks>;
  core: ChainMap<Networks, CoreConfig>;
  governance: ChainMap<Networks, GovernanceConfig>;
  infra: InfrastructureConfig;
  getMultiProvider: () => Promise<MultiProvider<Networks>>;
};
