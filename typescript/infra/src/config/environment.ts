import { CoreConfig, EnvironmentConfig } from '@abacus-network/deploy';
import { ChainMap, ChainName, MultiProvider } from '@abacus-network/sdk';

import { environments } from '../../config/environments';
import { ControllerConfig } from '../controller';

import { AgentConfig } from './agent';
import { InfrastructureConfig } from './infrastructure';

export const EnvironmentNames = Object.keys(environments);
export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreEnvironmentConfig<Chain extends ChainName> = {
  transactionConfigs: EnvironmentConfig<Chain>;
  agent: AgentConfig<Chain>;
  core: ChainMap<Chain, CoreConfig>;
  controller: ChainMap<Chain, ControllerConfig>;
  infra: InfrastructureConfig;
  getMultiProvider: () => Promise<MultiProvider<Chain>>;
};
