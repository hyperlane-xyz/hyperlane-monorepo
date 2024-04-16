import {
  BridgeAdapterConfig,
  ChainMap,
  ChainMetadata,
  ChainName,
  CoreConfig,
  HyperlaneEnvironment,
  IgpConfig,
  MultiProvider,
  OwnableConfig,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { environments } from '../../config/environments/index.js';
import { CloudAgentKey } from '../agents/keys.js';
import { Role } from '../roles.js';

import { RootAgentConfig } from './agent/agent.js';
import { KeyFunderConfig } from './funding.js';
import { HelloWorldConfig } from './helloworld/types.js';
import { InfrastructureConfig } from './infrastructure.js';
import { LiquidityLayerRelayerConfig } from './middleware.js';

// TODO: fix this?
export const EnvironmentNames = ['test', 'testnet4', 'mainnet3'];
export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof (typeof environments)[E],
  ChainName
>;

export type EnvironmentConfig = {
  environment: DeployEnvironment;
  chainMetadataConfigs: ChainMap<ChainMetadata>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, RootAgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<IgpConfig>;
  owners: ChainMap<OwnableConfig>;
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
};

export const deployEnvToSdkEnv: Record<
  DeployEnvironment,
  HyperlaneEnvironment
> = {
  test: 'testnet', // TODO: remove this
  mainnet3: 'mainnet',
  testnet4: 'testnet',
};
