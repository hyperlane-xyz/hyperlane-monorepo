import { type Logger, assert } from '@hyperlane-xyz/utils';

import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  IArtifactManager,
  RawArtifact,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import type { DerivedHookConfig, HookConfig } from './hook.js';
import type {
  DeployedIsmAddress,
  DerivedIsmConfig,
  IsmArtifactConfig,
  IsmConfig,
} from './ism.js';

export type TokenRouterModuleType = {
  config: WarpConfig;
  derived: DerivedWarpConfig;
  addresses: WarpRouteAddresses;
};

export const TokenType = {
  synthetic: 'synthetic',
  collateral: 'collateral',
  native: 'native',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export type RemoteRouters = Record<string, { address: string }>;
export type DestinationGas = Record<string, string>;

export interface BaseWarpConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule?: IsmConfig | string;
  hook?: HookConfig | string;
  remoteRouters?: RemoteRouters;
  destinationGas?: DestinationGas;
}

export interface CollateralWarpConfig extends BaseWarpConfig {
  type: 'collateral';
  token: string;
}

export interface SyntheticWarpConfig extends BaseWarpConfig {
  type: 'synthetic';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface NativeWarpConfig extends BaseWarpConfig {
  type: 'native';
}

export type WarpConfig =
  | CollateralWarpConfig
  | SyntheticWarpConfig
  | NativeWarpConfig;

export interface BaseDerivedWarpConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule: DerivedIsmConfig | string;
  hook: DerivedHookConfig | string;
  remoteRouters: RemoteRouters;
  destinationGas: DestinationGas;
}

export interface DerivedCollateralWarpConfig extends BaseDerivedWarpConfig {
  type: 'collateral';
  token: string;
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface DerivedSyntheticWarpConfig extends BaseDerivedWarpConfig {
  type: 'synthetic';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface DerivedNativeWarpConfig extends BaseDerivedWarpConfig {
  type: 'native';
}

export type DerivedWarpConfig =
  | DerivedCollateralWarpConfig
  | DerivedSyntheticWarpConfig
  | DerivedNativeWarpConfig;

export type WarpRouteAddresses = {
  deployedTokenRoute: string;
};

// Artifact API types

export interface DeployedWarpAddress {
  address: string;
}

/**
 * Base warp config for Artifact API.
 * Uses domain IDs (numbers) instead of chain names (strings) for remoteRouters and destinationGas keys.
 * ISM can be a nested artifact or just an address.
 */
interface BaseWarpArtifactConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule?: Artifact<IsmArtifactConfig, DeployedIsmAddress>;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface CollateralWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: 'collateral';
  token: string;
}

export interface SyntheticWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: 'synthetic';
  name: string;
  symbol: string;
  decimals: number;
}

export interface NativeWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: 'native';
}

export interface WarpArtifactConfigs {
  collateral: CollateralWarpArtifactConfig;
  synthetic: SyntheticWarpArtifactConfig;
  native: NativeWarpArtifactConfig;
}

export type WarpType = keyof WarpArtifactConfigs;

/**
 * Should be used for the specific artifact code that
 * deploys or reads any kind of warp token
 */
export type WarpArtifactConfig = WarpArtifactConfigs[WarpType];

/**
 * Describes the configuration of deployed warp token
 */
export type DeployedWarpArtifact = ArtifactDeployed<
  WarpArtifactConfig,
  DeployedWarpAddress
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of a warp token config
 */
export type IWarpArtifactManager = IArtifactManager<
  WarpType,
  WarpArtifactConfigs,
  DeployedWarpAddress
>;

type RawWarpTokenConfig<T extends WarpArtifactConfig> = RawArtifact<
  Omit<T, 'interchainSecurityModule'> & {
    interchainSecurityModule?: ArtifactOnChain<
      IsmArtifactConfig,
      DeployedIsmAddress
    >;
  },
  DeployedWarpAddress
>;

export type RawCollateralWarpArtifactConfig =
  RawWarpTokenConfig<CollateralWarpArtifactConfig>;

export type RawSyntheticWarpArtifactConfig =
  RawWarpTokenConfig<SyntheticWarpArtifactConfig>;

export type RawNativeWarpArtifactConfig =
  RawWarpTokenConfig<NativeWarpArtifactConfig>;

export interface RawWarpArtifactConfigs {
  collateral: RawCollateralWarpArtifactConfig;
  synthetic: RawSyntheticWarpArtifactConfig;
  native: RawNativeWarpArtifactConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single warp token artifact on chain
 */
export type RawWarpArtifactConfig = RawWarpArtifactConfigs[WarpType];

/**
 * Should be used to implement an object/closure or class that individually deploys
 * warp tokens on chain
 */
export interface IRawWarpArtifactManager
  extends IArtifactManager<
    WarpType,
    RawWarpArtifactConfigs,
    DeployedWarpAddress
  > {
  /**
   * Read any warp token by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading warp tokens of unknown types.
   * @param address The on-chain address of the warp token
   * @returns The artifact configuration and deployment data
   */
  readWarpToken(address: string): Promise<DeployedWarpArtifact>;
}

// Warp Config Utilities

/**
 * Converts WarpConfig (Config API) to WarpArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - String chain names → numeric domain IDs for remoteRouters/destinationGas keys
 * - ISM config → ISM artifact (handled by caller, passed through here)
 *
 * @param config The warp configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @param ismArtifact Optional ISM artifact if ISM is configured
 * @param logger Logger for warnings
 * @returns Artifact wrapper around WarpArtifactConfig suitable for artifact writers
 */
export function warpConfigToArtifact(
  config: WarpConfig,
  chainLookup: ChainLookup,
  ismArtifact?: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  logger?: Logger,
): ArtifactNew<WarpArtifactConfig> {
  // Convert remoteRouters from chain names to domain IDs
  const remoteRouters: Record<number, { address: string }> = {};
  if (config.remoteRouters) {
    for (const [chainName, router] of Object.entries(config.remoteRouters)) {
      const domainId = chainLookup.getDomainId(chainName);
      if (domainId === null) {
        logger?.warn(
          `Skipping remote router for unknown chain: ${chainName}. ` +
            `Chain not found in chain lookup.`,
        );
        continue;
      }
      remoteRouters[domainId] = router;
    }
  }

  // Convert destinationGas from chain names to domain IDs
  const destinationGas: Record<number, string> = {};
  if (config.destinationGas) {
    for (const [chainName, gas] of Object.entries(config.destinationGas)) {
      const domainId = chainLookup.getDomainId(chainName);
      if (domainId === null) {
        logger?.warn(
          `Skipping destination gas for unknown chain: ${chainName}. ` +
            `Chain not found in chain lookup.`,
        );
        continue;
      }
      destinationGas[domainId] = gas;
    }
  }

  const baseArtifactConfig = {
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: ismArtifact,
    remoteRouters,
    destinationGas,
  };

  switch (config.type) {
    case 'collateral':
      return {
        artifactState: ArtifactState.NEW,
        config: {
          ...baseArtifactConfig,
          type: 'collateral',
          token: config.token,
        },
      };

    case 'synthetic':
      // Validate required fields for synthetic token
      assert(config.name, 'name is required for synthetic token deployment');
      assert(
        config.symbol,
        'symbol is required for synthetic token deployment',
      );
      assert(
        config.decimals !== undefined,
        'decimals is required for synthetic token deployment',
      );

      return {
        artifactState: ArtifactState.NEW,
        config: {
          ...baseArtifactConfig,
          type: 'synthetic',
          name: config.name,
          symbol: config.symbol,
          decimals: config.decimals,
        },
      };

    case 'native':
      return {
        artifactState: ArtifactState.NEW,
        config: {
          ...baseArtifactConfig,
          type: 'native',
        },
      };

    default: {
      const invalidValue: never = config;
      throw new Error(
        `Unsupported warp token type for artifact API: ${(invalidValue as any).type}`,
      );
    }
  }
}

/**
 * Converts a DeployedWarpArtifact to DerivedWarpConfig format.
 * This handles the conversion between the new Artifact API and the old Config API.
 *
 * @param artifact The deployed warp artifact from the Artifact API
 * @param chainLookup Chain lookup interface for resolving domain IDs to chain names
 * @param derivedIsm Optional derived ISM config if ISM is configured
 * @returns Warp configuration in Config API format with address
 */
export function warpArtifactToDerivedConfig(
  artifact: DeployedWarpArtifact,
  chainLookup: ChainLookup,
  derivedIsm?: DerivedIsmConfig | string,
): DerivedWarpConfig {
  const config = artifact.config;

  // Convert remoteRouters from domain IDs back to chain names
  const remoteRouters: RemoteRouters = {};
  for (const [domainIdStr, router] of Object.entries(config.remoteRouters)) {
    const domainId = parseInt(domainIdStr);
    const chainName = chainLookup.getChainName(domainId);
    if (!chainName) {
      // Skip unknown domains
      continue;
    }
    remoteRouters[chainName] = router;
  }

  // Convert destinationGas from domain IDs back to chain names
  const destinationGas: DestinationGas = {};
  for (const [domainIdStr, gas] of Object.entries(config.destinationGas)) {
    const domainId = parseInt(domainIdStr);
    const chainName = chainLookup.getChainName(domainId);
    if (!chainName) {
      // Skip unknown domains
      continue;
    }
    destinationGas[chainName] = gas;
  }

  const baseDerivedConfig = {
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule:
      derivedIsm ?? '0x0000000000000000000000000000000000000000',
    hook: '0x0000000000000000000000000000000000000000',
    remoteRouters,
    destinationGas,
    name: config.name,
    symbol: config.symbol,
    decimals: config.decimals,
  };

  switch (config.type) {
    case 'collateral':
      return {
        ...baseDerivedConfig,
        type: TokenType.collateral,
        token: config.token,
      };

    case 'synthetic':
      return {
        ...baseDerivedConfig,
        type: TokenType.synthetic,
      };

    case 'native':
      return {
        ...baseDerivedConfig,
        type: TokenType.native,
      };

    default: {
      const invalidConfig: never = config;
      throw new Error(
        `Unhandled warp token type: ${(invalidConfig as any).type}`,
      );
    }
  }
}
