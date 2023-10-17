import {
  BridgeAdapterConfig,
  ChainMap,
  ChainMetadata,
  ChainName,
  CoreConfig,
  HyperlaneEnvironment,
  IgpConfig,
  MultiProvider,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { environments } from '../../config/environments';
import { CloudAgentKey } from '../agents/keys';
import { Role } from '../roles';

import { RootAgentConfig } from './agent';
import { KeyFunderConfig } from './funding';
import { AllStorageGasOracleConfigs } from './gas-oracle';
import { HelloWorldConfig } from './helloworld/types';
import { InfrastructureConfig } from './infrastructure';
import { LiquidityLayerRelayerConfig } from './middleware';

// TODO: fix this?
export const EnvironmentNames = ['test', 'testnet4', 'mainnet2'];
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
  igp: ChainMap<IgpConfig>;
  owners: ChainMap<Address>;
  infra: InfrastructureConfig;
  getMultiProvider: (
    context?: Contexts,
    role?: Role,
    connectionType?: RpcConsensusType,
  ) => Promise<MultiProvider>;
  getKeys: (
    context?: Contexts,
    role?: Role,
  ) => Promise<ChainMap<CloudAgentKey>>;
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
  test: 'testnet', // TODO: remove this
  mainnet2: 'mainnet',
  testnet4: 'testnet',
};
