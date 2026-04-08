import {
  type Logger,
  addressToBytes32,
  assert,
  difference,
  isNullish,
  objMap,
} from '@hyperlane-xyz/utils';

import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ConfigOnChain,
  IArtifactManager,
  addressToUnderivedArtifact,
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
  hookConfigToArtifact,
} from './hook.js';
import {
  type DeployedIsmAddress,
  type DerivedIsmConfig,
  type IsmArtifactConfig,
  type IsmConfig,
  ismArtifactToDerivedConfig,
  ismConfigToArtifact,
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
  crossCollateral: 'crossCollateral',
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
  scale?: number;
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
  metadataUri?: string;
}

export interface NativeWarpConfig extends BaseWarpConfig {
  type: 'native';
}

export interface CrossCollateralWarpConfig extends BaseWarpConfig {
  type: 'crossCollateral';
  token: string;
  crossCollateralRouters?: Record<string, string[]>;
}

export type WarpConfig =
  | CollateralWarpConfig
  | SyntheticWarpConfig
  | NativeWarpConfig
  | CrossCollateralWarpConfig;

export interface BaseDerivedWarpConfig {
  owner: string;
  mailbox: string;
  interchainSecurityModule: DerivedIsmConfig | string;
  hook: DerivedHookConfig | string;
  remoteRouters: RemoteRouters;
  destinationGas: DestinationGas;
  scale?: number;
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
  metadataUri?: string;
}

export interface DerivedNativeWarpConfig extends BaseDerivedWarpConfig {
  type: 'native';
}

export interface DerivedCrossCollateralWarpConfig extends BaseDerivedWarpConfig {
  type: 'crossCollateral';
  token: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  crossCollateralRouters: Record<string, string[]>;
}

export type DerivedWarpConfig =
  | DerivedCollateralWarpConfig
  | DerivedSyntheticWarpConfig
  | DerivedNativeWarpConfig
  | DerivedCrossCollateralWarpConfig;

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
  scale?: number;
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
  metadataUri?: string;
}

export interface NativeWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: typeof TokenType.native;
}

export interface CrossCollateralWarpArtifactConfig extends BaseWarpArtifactConfig {
  type: typeof TokenType.crossCollateral;
  token: string;
  crossCollateralRouters: Record<number, Set<string>>;
}

export interface WarpArtifactConfigs {
  collateral: CollateralWarpArtifactConfig;
  synthetic: SyntheticWarpArtifactConfig;
  native: NativeWarpArtifactConfig;
  crossCollateral: CrossCollateralWarpArtifactConfig;
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

export type RawCollateralWarpArtifactConfig =
  ConfigOnChain<CollateralWarpArtifactConfig>;

export type RawSyntheticWarpArtifactConfig =
  ConfigOnChain<SyntheticWarpArtifactConfig>;

export type RawNativeWarpArtifactConfig =
  ConfigOnChain<NativeWarpArtifactConfig>;

export type RawCrossCollateralWarpArtifactConfig =
  ConfigOnChain<CrossCollateralWarpArtifactConfig>;

export interface RawWarpArtifactConfigs {
  collateral: RawCollateralWarpArtifactConfig;
  synthetic: RawSyntheticWarpArtifactConfig;
  native: RawNativeWarpArtifactConfig;
  crossCollateral: RawCrossCollateralWarpArtifactConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single warp token artifact on chain
 */
export type RawWarpArtifactConfig = RawWarpArtifactConfigs[WarpType];

/**
 * Describes the configuration of deployed Warp artifact without nested config expansion
 */
export type DeployedRawWarpArtifact = ArtifactDeployed<
  RawWarpArtifactConfig,
  DeployedWarpAddress
>;

/**
 * Should be used to implement an object/closure or class that individually deploys
 * warp tokens on chain
 */
export interface IRawWarpArtifactManager extends IArtifactManager<
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
  readWarpToken(address: string): Promise<DeployedRawWarpArtifact>;

  /**
   * Whether this protocol supports attaching hook configs to warp tokens.
   * Protocols that don't implement setTokenHook should return false.
   */
  supportsHookUpdates(): boolean;
}

/**
 * Converts WarpConfig (Config API) to WarpArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - String chain names → numeric domain IDs for remoteRouters/destinationGas keys
 * - ISM config → ISM artifact (handled by caller, passed through here)
 *
 * @param config The warp configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @param logger Logger for warnings
 * @returns Artifact wrapper around WarpArtifactConfig suitable for artifact writers
 */
export function warpConfigToArtifact(
  config: WarpConfig,
  chainLookup: ChainLookup,
  logger?: Logger,
): ArtifactNew<WarpArtifactConfig> {
  // Convert ISM config to artifact if present
  let ismArtifact: Artifact<IsmArtifactConfig, DeployedIsmAddress> | undefined;
  if (config.interchainSecurityModule) {
    if (typeof config.interchainSecurityModule === 'string') {
      // Normalize zero-address references to "unset" before artifact conversion.
      ismArtifact = addressToUnderivedArtifact(config.interchainSecurityModule);
    } else {
      // ISM config - convert using ismConfigToArtifact
      ismArtifact = ismConfigToArtifact(
        config.interchainSecurityModule,
        chainLookup,
      );
    }
  }

  // Convert Hook config to artifact if present
  let hookArtifact:
    | Artifact<HookArtifactConfig, DeployedHookAddress>
    | undefined;
  if (config.hook) {
    if (typeof config.hook === 'string') {
      // Normalize zero-address references to "unset" before artifact conversion.
      hookArtifact = addressToUnderivedArtifact(config.hook);
    } else {
      // Hook config - convert using hookConfigToArtifact
      hookArtifact = hookConfigToArtifact(config.hook, chainLookup);
    }
  }

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
    hook: hookArtifact,
    remoteRouters,
    destinationGas,
    scale: config.scale,
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
          metadataUri: config.metadataUri,
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

    case 'crossCollateral':
      return {
        artifactState: ArtifactState.NEW,
        config: {
          ...baseArtifactConfig,
          type: 'crossCollateral',
          token: config.token,
          crossCollateralRouters: convertCrossCollateralRoutersToArtifact(
            config.crossCollateralRouters,
            chainLookup,
            logger,
          ),
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
    scale: config.scale,
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
        metadataUri: config.metadataUri,
      };

    case 'native':
      return {
        ...baseDerivedConfig,
        type: TokenType.native,
      };

    case 'crossCollateral':
      return {
        ...baseDerivedConfig,
        type: TokenType.crossCollateral,
        token: config.token,
        crossCollateralRouters: convertCrossCollateralRoutersToDerived(
          config.crossCollateralRouters,
          chainLookup,
        ),
      };
    default: {
      const invalidConfig: never = config;
      throw new Error(
        `Unhandled warp token type: ${JSON.stringify(invalidConfig)}`,
      );
    }
  }
}

// Cross-Collateral Router Utilities

function convertCrossCollateralRoutersToArtifact(
  crossCollateralRouters: Record<string, string[]> | undefined,
  chainLookup: ChainLookup,
  logger?: Logger,
): Record<number, Set<string>> {
  const result: Record<number, Set<string>> = {};
  if (!crossCollateralRouters) return result;

  for (const [chainName, routers] of Object.entries(crossCollateralRouters)) {
    const domainId = chainLookup.getDomainId(chainName);
    if (isNullish(domainId)) {
      logger?.warn(
        `Skipping cross-collateral routers for unknown chain: ${chainName}. ` +
          `Chain not found in chain lookup.`,
      );
      continue;
    }
    result[domainId] = new Set(routers);
  }
  return result;
}

function convertCrossCollateralRoutersToDerived(
  crossCollateralRouters: Record<number, Set<string>>,
  chainLookup: ChainLookup,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const [domainIdStr, routers] of Object.entries(crossCollateralRouters)) {
    const domainId = parseInt(domainIdStr);
    const chainName = chainLookup.getChainName(domainId);
    if (!chainName) continue;
    result[chainName] = Array.from(routers);
  }

  return result;
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
      expectedRoutersConfig.destinationGas[domainId];
    assert(
      !isNullish(expectedDestinationGas),
      `Missing destination gas for domain ${domainId} in expected router configuration`,
    );
    const currentRouterAddress = Object.prototype.hasOwnProperty.call(
      currentRoutersConfig.remoteRouters,
      domainId,
    )
      ? currentRoutersConfig.remoteRouters[domainId].address
      : undefined;
    const currentDestinationGas =
      currentRoutersConfig.destinationGas[domainId] ?? '0';

    const needsUpdate =
      !currentRouterAddress ||
      !compareAddresses(currentRouterAddress, expectedRemoteRouter.address) ||
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

export interface CrossCollateralRouterDiff {
  /** Per-domain routers to enroll */
  toEnroll: Record<number, Set<string>>;
  /** Per-domain routers to unenroll (null = bulk-remove entire domain) */
  toUnenroll: Record<number, Set<string> | null>;
}

/**
 * Computes which cross-collateral routers need enrollment/unenrollment by
 * diffing current and expected CC router maps.
 * Pure function — protocol-agnostic. Addresses are canonicalized to lowercase
 * hex32 before comparison so callers don't need to normalize beforehand.
 */
export function computeCrossCollateralRouterUpdates(
  current: Readonly<Record<number, Set<string>>>,
  expected: Readonly<Record<number, Set<string>>>,
): CrossCollateralRouterDiff {
  const canonicalize = (routers: Readonly<Record<number, Set<string>>>) =>
    objMap(
      routers,
      (_domain, routerSet) =>
        new Set([...routerSet].map((r) => addressToBytes32(r).toLowerCase())),
    );

  const canonicalCurrent = canonicalize(current);
  const canonicalExpected = canonicalize(expected);

  const toUnenroll: Record<number, Set<string> | null> = {};
  for (const [domainStr, currentSet] of Object.entries(canonicalCurrent)) {
    const domain = Number(domainStr);
    const expectedSet = canonicalExpected[domain];
    if (isNullish(expectedSet) || expectedSet.size === 0) {
      toUnenroll[domain] = null;
    } else {
      const removed = difference(currentSet, expectedSet);
      if (removed.size > 0) {
        toUnenroll[domain] = removed;
      }
    }
  }

  const toEnroll: Record<number, Set<string>> = {};
  for (const [domainStr, expectedSet] of Object.entries(canonicalExpected)) {
    const domain = Number(domainStr);
    const currentSet = canonicalCurrent[domain] ?? new Set();
    const added = difference(expectedSet, currentSet);
    if (added.size > 0) {
      toEnroll[domain] = added;
    }
  }

  return { toEnroll, toUnenroll };
}

export interface CCGasConfigDiff {
  toEnroll: Array<{ domain: number; gas: string }>;
  toUnenroll: number[];
}

/**
 * Computes destination gas updates for CC-only domains — domains present in
 * crossCollateralRouters but NOT in remoteRouters.
 * Pure function — protocol-agnostic.
 */
export function computeCCRouterGasConfigUpdates(
  currentDestinationGas: Readonly<Record<number, string>>,
  expectedDestinationGas: Readonly<Record<number, string>>,
  expectedRemoteRouterDomains: ReadonlySet<number>,
  currentCCRouters: Readonly<Record<number, Set<string>>>,
  expectedCCRouters: Readonly<Record<number, Set<string>>>,
): CCGasConfigDiff {
  const allCCDomains = new Set([
    ...Object.keys(currentCCRouters).map(Number),
    ...Object.keys(expectedCCRouters).map(Number),
  ]);

  const toEnroll: CCGasConfigDiff['toEnroll'] = [];
  const toUnenroll: number[] = [];

  for (const domain of allCCDomains) {
    if (expectedRemoteRouterDomains.has(domain)) continue;

    const currentGas = currentDestinationGas[domain];
    const expectedGas = expectedDestinationGas[domain];
    const hasExpectedCCRouters = (expectedCCRouters[domain]?.size ?? 0) > 0;

    if (hasExpectedCCRouters && expectedGas && currentGas !== expectedGas) {
      toEnroll.push({ domain, gas: expectedGas });
    } else if (!hasExpectedCCRouters && currentGas) {
      toUnenroll.push(domain);
    }
  }

  return { toEnroll, toUnenroll };
}
