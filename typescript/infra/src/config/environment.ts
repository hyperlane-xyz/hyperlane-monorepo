import {
  ChainMap,
  ChainName,
  CoreConfig,
  EnvironmentConfig,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { CoreEnvironment } from '@hyperlane-xyz/sdk/dist/core/HyperlaneCore';

import { Contexts } from '../../config/contexts';
import { environments } from '../../config/environments';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { AgentConfig, ConnectionType } from './agent';
import { KeyFunderConfig } from './funding';
import { AllStorageGasOracleConfigs } from './gas-oracle';
import { HelloWorldConfig } from './helloworld';
import { InfrastructureConfig } from './infrastructure';
import { LiquidityLayerRelayerConfig } from './middleware';

export const EnvironmentNames = Object.keys(environments);
export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreEnvironmentConfig<Chain extends ChainName> = {
  environment: DeployEnvironment;
  transactionConfigs: EnvironmentConfig<Chain>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, AgentConfig<Chain>>>;
  core: ChainMap<Chain, CoreConfig>;
  infra: InfrastructureConfig;
  getMultiProvider: (
    context?: Contexts,
    role?: KEY_ROLE_ENUM,
    connectionType?: ConnectionType,
  ) => Promise<MultiProvider<Chain>>;
  helloWorld?: Partial<Record<Contexts, HelloWorldConfig<Chain>>>;
  keyFunderConfig?: KeyFunderConfig;
  liquidityLayerRelayerConfig?: LiquidityLayerRelayerConfig;
  storageGasOracleConfig?: AllStorageGasOracleConfigs<Chain>;
};

export const deployEnvToSdkEnv: Record<DeployEnvironment, CoreEnvironment> = {
  mainnet2: 'mainnet',
  testnet3: 'testnet',
  test: 'test',
};
