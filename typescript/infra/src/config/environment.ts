import {
  AgentConnectionType,
  BridgeAdapterConfig,
  ChainMap,
  ChainMetadata,
  ChainName,
  CoreConfig,
  MultiProvider,
  OverheadIgpConfig,
} from '@hyperlane-xyz/sdk';
import { HyperlaneEnvironment } from '@hyperlane-xyz/sdk/dist/consts/environments';
import { types } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { environments } from '../../config/environments';
import { Role } from '../roles';

import { RootAgentConfig } from './agent';
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

export type EnvironmentConfig = {
  environment: DeployEnvironment;
  chainMetadataConfigs: ChainMap<ChainMetadata>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, RootAgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<OverheadIgpConfig>;
  owners: ChainMap<types.Address>;
  infra: InfrastructureConfig;
  getMultiProvider: (
    context?: Contexts,
    role?: Role,
    connectionType?: AgentConnectionType,
  ) => Promise<MultiProvider>;
  helloWorld?: Partial<Record<Contexts, HelloWorldConfig>>;
  keyFunderConfig?: KeyFunderConfig;
  liquidityLayerConfig?: {
    bridgeAdapters: ChainMap<BridgeAdapterConfig>;
    relayer: LiquidityLayerRelayerConfig;
  };
  storageGasOracleConfig?: AllStorageGasOracleConfigs;
};

export const deployEnvToSdkEnv: Record<
  DeployEnvironment,
  HyperlaneEnvironment
> = {
  mainnet2: 'mainnet',
  testnet3: 'testnet',
  test: 'test',
};
