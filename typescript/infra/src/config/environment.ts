import {
  ChainMap,
  ChainName,
  CoreConfig,
  EnvironmentConfig,
  MultiProvider,
} from '@abacus-network/sdk';

import { environments } from '../../config/environments';

import { AgentConfig } from './agent';
import { InfrastructureConfig } from './infrastructure';

export const EnvironmentNames = Object.keys(environments);
export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreEnvironmentConfig<Chain extends ChainName> = {
  environment: DeployEnvironment;
  transactionConfigs: EnvironmentConfig<Chain>;
  agent: AgentConfig<Chain>;
  core: ChainMap<Chain, CoreConfig>;
  infra: InfrastructureConfig;
  getMultiProvider: () => Promise<MultiProvider<Chain>>;
  helloWorldAddresses?: ChainMap<Chain, { router: string }>;
};
