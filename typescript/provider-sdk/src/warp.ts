import { type Logger, assert, isNullish } from '@hyperlane-xyz/utils';

import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ConfigOnChain,
  IArtifactManager,
  isArtifactDeployed,
  isArtifactNew,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  type DeployedHookAddress,
  type DerivedHookConfig,
  type HookArtifactConfig,
  type HookConfig,
  hookArtifactToDerivedConfig,
} from './hook.js';
import {
  type DeployedIsmAddress,
  type DerivedIsmConfig,
  type IsmArtifactConfig,
  type IsmConfig,
  ismArtifactToDerivedConfig,
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
  hook?: Artifact<HookArtifactConfig, DeployedHookAddress>;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface CollateralWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: typeof TokenType.collateral;
  token: string;
}

export interface SyntheticWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: typeof TokenType.synthetic;
  name: string;
  symbol: string;
  decimals: number;
}

export interface NativeWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: typeof TokenType.native;
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
  ConfigOnChain<WarpArtifactConfig>,
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

export type RawCollateralWarpArtifactConfig =
  ConfigOnChain<CollateralWarpArtifactConfig>;

export type RawSyntheticWarpArtifactConfig =
  ConfigOnChain<SyntheticWarpArtifactConfig>;

export type RawNativeWarpArtifactConfig =
  ConfigOnChain<NativeWarpArtifactConfig>;

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
      if (isNullish(domainId)) {
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
      if (isNullish(domainId)) {
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
      const invalidConfig: never = config;
      throw new Error(
        `Unsupported warp token type for artifact API: ${JSON.stringify(invalidConfig)}`,
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

  // Convert ISM artifact to config if present
  assert(
    isNullish(config.interchainSecurityModule) ||
      !isArtifactNew(config.interchainSecurityModule),
    'Expected ISM to be a deployed or underived artifact',
  );
  let ismConfig: DerivedWarpConfig['interchainSecurityModule'];
  if (isNullish(config.interchainSecurityModule)) {
    ismConfig = '0x0000000000000000000000000000000000000000';
  } else if (isArtifactDeployed(config.interchainSecurityModule)) {
    ismConfig = ismArtifactToDerivedConfig(
      config.interchainSecurityModule,
      chainLookup,
    );
  } else {
    ismConfig = config.interchainSecurityModule.deployed.address;
  }

  // Convert hook artifact to config if present
  assert(
    isNullish(config.hook) || !isArtifactNew(config.hook),
    'Expected hook to be a deployed or underived artifact',
  );
  let hookConfig: DerivedWarpConfig['hook'];
  if (isNullish(config.hook)) {
    hookConfig = '0x0000000000000000000000000000000000000000';
  } else if (isArtifactDeployed(config.hook)) {
    hookConfig = hookArtifactToDerivedConfig(config.hook, chainLookup);
  } else {
    hookConfig = config.hook.deployed.address;
  }

  const baseDerivedConfig = {
    owner: config.owner,
    mailbox: config.mailbox,
    interchainSecurityModule: ismConfig,
    hook: hookConfig,
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
        `Unhandled warp token type: ${JSON.stringify(invalidConfig)}`,
      );
    }
  }
}

// Warp Router Update Utilities

export interface WarpRouterDiff {
  /** Routers that need to be enrolled or updated */
  toEnroll: Array<{
    domainId: number;
    routerAddress: string;
    gas: string;
  }>;
  /** Domain IDs where router needs to be unenrolled */
  toUnenroll: number[];
}

type RemoteRoutersConfig = Pick<
  RawWarpArtifactConfig,
  'destinationGas' | 'remoteRouters'
>;

/**
 * Computes which routers need enrollment/unenrollment by diffing current and expected configs.
 * Pure function - compares router addresses and destination gas to determine required updates.
 *
 * @param currentRoutersConfig Current on-chain router state
 * @param expectedRoutersConfig Desired router state
 * @param compareAddresses VM-specific address comparison (handles case/format differences)
 * @returns Lists of domains to enroll/unenroll
 */
export function computeRemoteRoutersUpdates(
  currentRoutersConfig: Readonly<RemoteRoutersConfig>,
  expectedRoutersConfig: Readonly<RemoteRoutersConfig>,
  compareAddresses: (a: string, b: string) => boolean,
): WarpRouterDiff {
  const currentDomains = new Set(
    Object.keys(currentRoutersConfig.remoteRouters).map((k) => parseInt(k)),
  );
  const desiredDomains = new Set(
    Object.keys(expectedRoutersConfig.remoteRouters).map((k) => parseInt(k)),
  );

  const toUnenroll: number[] = [];
  const toEnroll: WarpRouterDiff['toEnroll'] = [];

  // Unenroll routers not in desired config (removed domains)
  for (const domainId of currentDomains) {
    if (!desiredDomains.has(domainId)) {
      toUnenroll.push(domainId);
    }
  }

  // Enroll/update routers (new domains or changed router/gas)
  for (const [domainIdStr, expectedRemoteRouter] of Object.entries(
    expectedRoutersConfig.remoteRouters,
  )) {
    const domainId = parseInt(domainIdStr);
    const expectedDestinationGas =
      expectedRoutersConfig.destinationGas[domainId] ?? '0';
    const currentRouterAddress = currentRoutersConfig.remoteRouters[domainId];
    const currentDestinationGas =
      currentRoutersConfig.destinationGas[domainId] ?? '0';

    const needsUpdate =
      !currentRouterAddress ||
      !compareAddresses(
        currentRouterAddress.address,
        expectedRemoteRouter.address,
      ) ||
      currentDestinationGas !== expectedDestinationGas;

    if (needsUpdate) {
      toEnroll.push({
        domainId,
        routerAddress: expectedRemoteRouter.address,
        gas: expectedDestinationGas,
      });
    }
  }

  return { toEnroll, toUnenroll };
}
