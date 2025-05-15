import { IRegistry } from '@hyperlane-xyz/registry';
import {
  BridgeAdapterConfig,
  ChainMap,
  ChainName,
  CoreConfig,
  IgpConfig,
  MultiProtocolProvider,
  MultiProvider,
  OwnableConfig,
  RouterConfig,
} from '@hyperlane-xyz/sdk';
import { mustGet, objKeys, objMap, objMerge } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { environments } from '../../config/environments/index.js';
import { awIcas } from '../../config/environments/mainnet3/governance/ica/aw.js';
import { awSafes } from '../../config/environments/mainnet3/governance/safe/aw.js';
import {
  DEPLOYER,
  upgradeTimelocks,
} from '../../config/environments/mainnet3/owners.js';
import { getHyperlaneCore } from '../../scripts/core-utils.js';
import { CloudAgentKey } from '../agents/keys.js';
import { Role } from '../roles.js';

import { RootAgentConfig } from './agent/agent.js';
import { CheckWarpDeployConfig, KeyFunderConfig } from './funding.js';
import { HelloWorldConfig } from './helloworld/types.js';
import { InfrastructureConfig } from './infrastructure.js';
import { LiquidityLayerRelayerConfig } from './middleware.js';

export type DeployEnvironment = keyof typeof environments;
export type EnvironmentChain<E extends DeployEnvironment> = Extract<
  keyof (typeof environments)[E],
  ChainName
>;
export enum AgentEnvironment {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}
export const envNameToAgentEnv: Record<DeployEnvironment, AgentEnvironment> = {
  test: AgentEnvironment.Testnet,
  testnet4: AgentEnvironment.Testnet,
  mainnet3: AgentEnvironment.Mainnet,
};

export type EnvironmentConfig = {
  environment: DeployEnvironment;
  supportedChainNames: ChainName[];
  // Get the registry with or without environment-specific secrets.
  getRegistry: (useSecrets?: boolean) => Promise<IRegistry>;
  // Each AgentConfig, keyed by the context
  agents: Partial<Record<Contexts, RootAgentConfig>>;
  core: ChainMap<CoreConfig>;
  igp: ChainMap<IgpConfig>;
  owners: ChainMap<OwnableConfig>;
  infra: InfrastructureConfig;
  getMultiProtocolProvider: () => Promise<MultiProtocolProvider>;
  getMultiProvider: (
    context?: Contexts,
    role?: Role,
    useSecrets?: boolean,
    chains?: ChainName[],
  ) => Promise<MultiProvider>;
  getKeys: (
    context?: Contexts,
    role?: Role,
  ) => Promise<ChainMap<CloudAgentKey>>;
  helloWorld?: Partial<Record<Contexts, HelloWorldConfig>>;
  keyFunderConfig?: KeyFunderConfig<string[]>;
  checkWarpDeployConfig?: CheckWarpDeployConfig;
  liquidityLayerConfig?: {
    bridgeAdapters: ChainMap<BridgeAdapterConfig>;
    relayer: LiquidityLayerRelayerConfig;
  };
};

export function assertEnvironment(env: string): DeployEnvironment {
  const envNames = objKeys(environments);
  if (envNames.includes(env as any)) {
    return env as DeployEnvironment;
  }
  throw new Error(`Invalid environment ${env}, must be one of ${envNames}`);
}

// Gets the router configs for all chains in the environment.
// Relying solely on HyperlaneCore.getRouterConfig will result
// in missing any non-EVM chains -- here we merge the two.
export async function getRouterConfigsForAllVms(
  envConfig: EnvironmentConfig,
  multiProvider: MultiProvider,
): Promise<ChainMap<RouterConfig>> {
  const { core, chainAddresses } = await getHyperlaneCore(
    envConfig.environment,
    multiProvider,
  );

  // Core deployment governance is changing.
  // For now stick with the previous ownership setup.
  const ownerConfigs: ChainMap<OwnableConfig> = objMap(
    envConfig.owners,
    (chain, _) => {
      const owner = awIcas[chain] ?? awSafes[chain] ?? DEPLOYER;
      return {
        owner,
        ownerOverrides: {
          proxyAdmin: upgradeTimelocks[chain] ?? owner,
          validatorAnnounce: DEPLOYER,
          testRecipient: DEPLOYER,
          fallbackRoutingHook: DEPLOYER,
          ...(awSafes[chain] && { _safeAddress: awSafes[chain] }),
          ...(awIcas[chain] && { _icaAddress: awIcas[chain] }),
        },
      };
    },
  );

  const evmRouterConfig = core.getRouterConfig(ownerConfigs);

  const allRouterConfigs: ChainMap<RouterConfig> = objMap(
    chainAddresses,
    (chain, addresses) => {
      return {
        mailbox: mustGet(addresses, 'mailbox'),
        owner: mustGet(envConfig.owners, chain).owner,
      };
    },
  );

  // Merge, giving evmRouterConfig precedence
  return objMerge(allRouterConfigs, evmRouterConfig);
}

export function getOwnerConfigForAddress(owner: string): OwnableConfig {
  return {
    owner,
    // To ensure that any other overrides aren't applied
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };
}
