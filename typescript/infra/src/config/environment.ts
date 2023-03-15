import {
  AgentConnectionType,
  ChainMap,
  ChainMetadata,
  ChainName,
  CoreConfig,
  CoreEnvironment,
  MultiProvider,
  OverheadIgpConfig,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { environments } from '../../config/environments';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { AgentConfig } from './agent';
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

export type CoreEnvironmentConfig = {
  environment: DeployEnvironment;
  chainMetadataConfigs: ChainMap<ChainMetadata>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, AgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<OverheadIgpConfig>;
  owners: ChainMap<types.Address>;
  infra: InfrastructureConfig;
  getMultiProvider: (
    context?: Contexts,
    role?: KEY_ROLE_ENUM,
    connectionType?: AgentConnectionType,
  ) => Promise<MultiProvider>;
  helloWorld?: Partial<Record<Contexts, HelloWorldConfig>>;
  keyFunderConfig?: KeyFunderConfig;
  liquidityLayerRelayerConfig?: LiquidityLayerRelayerConfig;
  storageGasOracleConfig?: AllStorageGasOracleConfigs;
};

export const deployEnvToSdkEnv: Record<DeployEnvironment, CoreEnvironment> = {
  mainnet2: 'mainnet',
  testnet3: 'testnet',
  test: 'test',
};
