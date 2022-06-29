import { CoreConfig, EnvironmentConfig } from '@abacus-network/deploy';
import { ChainMap, ChainName, MultiProvider } from '@abacus-network/sdk';

import { environments } from '../../config/environments';

import { AgentConfig } from './agent';
import { HelloWorldConfig } from './helloworld';
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
  helloWorld?: HelloWorldConfig<Chain>;
};
