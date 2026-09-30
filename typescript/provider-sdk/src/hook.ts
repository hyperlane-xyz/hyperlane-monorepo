import {
  Logger,
  WithAddress,
  assert,
  deepEquals,
  normalizeConfig,
  rootLogger,
} from '@hyperlane-xyz/utils';

import * as AltVM from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
  ConfigOnChain,
  IArtifactManager,
  isArtifactDeployed,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import { ProtocolType } from './protocolType.js';

function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled hook type in ${context}: ${String(value)}`);
}

export type HookModuleType = {
  config: HookConfig;
  derived: DerivedHookConfig;
  addresses: HookModuleAddresses;
};

export const HookType = {
  /**
   * Retained for backwards compatibility with pre-deployed hooks that don't fit
   * a named type. Cannot be deployed by standard hook deployers. New code should
   * use a specific named hook type.
   */
  CUSTOM: 'custom',
  MERKLE_TREE: 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER: 'interchainGasPaymaster',
  AGGREGATION: 'aggregationHook',
  PROTOCOL_FEE: 'protocolFee',
  OP_STACK: 'opStackHook',
  ROUTING: 'domainRoutingHook',
  FALLBACK_ROUTING: 'fallbackRoutingHook',
  AMOUNT_ROUTING: 'amountRoutingHook',
  PAUSABLE: 'pausableHook',
  ARB_L2_TO_L1: 'arbL2ToL1Hook',
  MAILBOX_DEFAULT: 'defaultHook',
  CCIP: 'ccipHook',
  /**
   * References a pre-deployed CCTP hook by address. Standard hook deployers
   * connect to `config.address` instead of deploying it.
   */
  CCTP: 'cctpHook',
  /**
   * Rate-limits outbound token volume on the origin chain at dispatch time.
   * Warp-route only. Not valid for core required/default hooks.
   */
  RATE_LIMITED: 'rateLimitedHook',
  /**
   * Hook view of the NetFlowRateLimitedHookIsm hybrid: one contract instance
   * is installed as both the hook and the ISM of a single warp router.
   * Read-only on the hook side; deployed through the ISM configuration and
   * referenced by address as the hook.
   */
  NET_FLOW_RATE_LIMITED: 'netFlowRateLimitedHookIsm',
  /**
   * Hook view of the DelayedFlowRouterHookIsm hybrid. Like
   * NET_FLOW_RATE_LIMITED, it is deployed through the ISM configuration and
   * referenced by address as the hook.
   */
  DELAYED_FLOW_ROUTER: 'delayedFlowRouterHookIsm',
  UNKNOWN: 'unknownHook',
  PREDICATE: 'predicateHook',
} as const;

export type HookType = (typeof HookType)[keyof typeof HookType];

export interface OwnableHookConfig {
  owner: string;
}

export interface GasOracleConfig {
  gasPrice: string;
  tokenExchangeRate: string;
  tokenDecimals?: number;
  typicalCost?: {
    handleGasAmount: number;
    totalGasAmount: number;
    totalUsdCost: number;
  };
}

export interface HookConfigs {
  [HookType.MERKLE_TREE]: MerkleTreeHookConfig;
  [HookType.INTERCHAIN_GAS_PAYMASTER]: IgpHookModuleConfig;
  [HookType.PROTOCOL_FEE]: ProtocolFeeHookModuleConfig;
  [HookType.UNKNOWN]: UnknownHookConfig;
}

export type HookConfigType = keyof HookConfigs;
export type HookConfig = HookConfigs[HookConfigType];
export type DerivedHookConfig = WithAddress<HookConfig>;

export function altVmHookTypeToProviderHookType(
  hookType: AltVM.HookType,
): HookType {
  switch (hookType) {
    case AltVM.HookType.CUSTOM:
      return HookType.CUSTOM;
    case AltVM.HookType.MERKLE_TREE:
      return HookType.MERKLE_TREE;
    case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
      return HookType.INTERCHAIN_GAS_PAYMASTER;
    case AltVM.HookType.AGGREGATION:
      return HookType.AGGREGATION;
    case AltVM.HookType.PROTOCOL_FEE:
      return HookType.PROTOCOL_FEE;
    case AltVM.HookType.OP_STACK:
      return HookType.OP_STACK;
    case AltVM.HookType.ROUTING:
      return HookType.ROUTING;
    case AltVM.HookType.FALLBACK_ROUTING:
      return HookType.FALLBACK_ROUTING;
    case AltVM.HookType.AMOUNT_ROUTING:
      return HookType.AMOUNT_ROUTING;
    case AltVM.HookType.PAUSABLE:
      return HookType.PAUSABLE;
    case AltVM.HookType.ARB_L2_TO_L1:
      return HookType.ARB_L2_TO_L1;
    case AltVM.HookType.MAILBOX_DEFAULT:
      return HookType.MAILBOX_DEFAULT;
    case AltVM.HookType.CCIP:
      return HookType.CCIP;
    default:
      return assertNever(hookType, 'altVmHookTypeToProviderHookType');
  }
}

/** Hook types whose configuration can be updated in place. */
export const MUTABLE_HOOK_TYPE = [
  HookType.INTERCHAIN_GAS_PAYMASTER,
  HookType.PROTOCOL_FEE,
  HookType.ROUTING,
  HookType.FALLBACK_ROUTING,
  HookType.PAUSABLE,
  HookType.RATE_LIMITED,
] as const satisfies readonly HookType[];

export type MutableHookType = (typeof MUTABLE_HOOK_TYPE)[number];

export function isMutableHookConfig<T extends { type: HookType }>(
  config: T,
): config is Extract<T, { type: MutableHookType }> {
  return MUTABLE_HOOK_TYPE.some((mutableType) => mutableType === config.type);
}

export interface IgpHookModuleConfig {
  type: typeof HookType.INTERCHAIN_GAS_PAYMASTER;
  // FIXME: oracleKey and owner should be nullable but the change requires too many files to be touched
  // address is an separate PR
  owner: string;
  beneficiary: string;
  oracleKey: string;
  overhead: Record<string, number>;
  oracleConfig: Record<string, GasOracleConfig>;
  contractVersion?: string;
  quoteSigners?: string[];
  tokenOracleConfig?: Record<string, Record<string, GasOracleConfig>>;
}

export interface MerkleTreeHookConfig {
  type: typeof HookType.MERKLE_TREE;
  address?: string;
}

export interface CustomHookConfig {
  type: typeof HookType.CUSTOM;
  address: string;
}

export interface UnknownHookConfig {
  type: typeof HookType.UNKNOWN;
  [key: string]: unknown;
}

export interface ProtocolFeeHookModuleConfig extends OwnableHookConfig {
  type: typeof HookType.PROTOCOL_FEE;
  beneficiary: string;
  maxProtocolFee: string;
  protocolFee: string;
}

export interface PausableHookConfig extends OwnableHookConfig {
  type: typeof HookType.PAUSABLE;
  paused: boolean;
  address?: string;
}

export interface OpStackHookConfig extends OwnableHookConfig {
  type: typeof HookType.OP_STACK;
  nativeBridge: string;
  destinationChain: string;
}

export interface AggregationHookConfig {
  type: typeof HookType.AGGREGATION;
  hooks: HookConfig[];
  address?: string;
}

export interface DomainRoutingHookConfig extends OwnableHookConfig {
  type: typeof HookType.ROUTING;
  domains: Record<string, HookConfig>;
  address?: string;
}

export interface FallbackRoutingHookConfig extends OwnableHookConfig {
  type: typeof HookType.FALLBACK_ROUTING;
  domains: Record<string, HookConfig>;
  fallback: HookConfig;
  address?: string;
}

export interface AmountRoutingHookConfig {
  type: typeof HookType.AMOUNT_ROUTING;
  threshold: number;
  lowerHook: HookConfig;
  upperHook: HookConfig;
}

export interface ArbL2ToL1HookConfig {
  type: typeof HookType.ARB_L2_TO_L1;
  arbSys: string;
  bridge?: string;
  destinationChain: string;
  childHook: HookConfig;
}

export interface MailboxDefaultHookConfig {
  type: typeof HookType.MAILBOX_DEFAULT;
}

export interface CcipHookConfig {
  type: typeof HookType.CCIP;
  destinationChain: string;
}

export interface CctpHookConfig {
  type: typeof HookType.CCTP;
  address: string;
}

export interface RateLimitedHookConfig extends OwnableHookConfig {
  type: typeof HookType.RATE_LIMITED;
  maxCapacity: string;
  duration: bigint;
}

export interface NetFlowRateLimitedHookConfig {
  type: typeof HookType.NET_FLOW_RATE_LIMITED;
  warpRouter?: string;
  thresholdBps: number;
  duration: bigint;
  owner?: string;
}

export interface DelayedFlowRouterHookConfig extends OwnableHookConfig {
  type: typeof HookType.DELAYED_FLOW_ROUTER;
  warpRouter?: string;
  thresholdBps: number;
  maxDelay: number;
  duration: bigint;
  remoteIsms?: Record<string, string>;
}

export interface PredicateHookConfig {
  type: typeof HookType.PREDICATE;
  address: string;
}

export interface ProtocolFeeHookConfig extends OwnableHookConfig {
  type: typeof HookType.PROTOCOL_FEE;
  beneficiary: string;
  maxProtocolFee: string;
  protocolFee: string;
}

export type HookModuleAddresses = {
  deployedHook: string;
  mailbox: string;
};

// Artifact API types

export interface DeployedHookAddress {
  address: string;
}

/**
 * IGP Hook config for Artifact API.
 * Uses domain IDs (numbers) instead of chain names (strings) for overhead and oracleConfig keys.
 * This differs from IgpHookModuleConfig which uses chain names for the Config API.
 */
export interface IgpHookConfig {
  type: typeof HookType.INTERCHAIN_GAS_PAYMASTER;
  // FIXME: oracleKey and owner should be nullable but the change requires too many files to be touched
  // address is an separate PR
  owner: string;
  beneficiary: string;
  oracleKey: string;
  overhead: Record<number, number>;
  oracleConfig: Record<number, GasOracleConfig>;
  contractVersion?: string;
  quoteSigners?: string[];
  tokenOracleConfig?: Record<string, Record<number, GasOracleConfig>>;
}

/**
 * Rejects IGP fields that the current non-EVM writers cannot apply on chain.
 */
export function assertNoUnsupportedIgpFields(
  config: Pick<IgpHookConfig, 'tokenOracleConfig'>,
  protocol: ProtocolType,
): void {
  assert(
    config.tokenOracleConfig === undefined,
    `tokenOracleConfig is not supported on ${protocol} IGP hooks`,
  );
}

export interface AggregationHookArtifactConfig {
  type: typeof HookType.AGGREGATION;
  hooks: Artifact<HookArtifactConfig, DeployedHookAddress>[];
  address?: string;
}

export interface DomainRoutingHookArtifactConfig extends OwnableHookConfig {
  type: typeof HookType.ROUTING;
  domains: Record<number, Artifact<HookArtifactConfig, DeployedHookAddress>>;
  address?: string;
}

export interface FallbackRoutingHookArtifactConfig extends OwnableHookConfig {
  type: typeof HookType.FALLBACK_ROUTING;
  domains: Record<number, Artifact<HookArtifactConfig, DeployedHookAddress>>;
  fallback: Artifact<HookArtifactConfig, DeployedHookAddress>;
  address?: string;
}

export interface AmountRoutingHookArtifactConfig {
  type: typeof HookType.AMOUNT_ROUTING;
  threshold: number;
  lowerHook: Artifact<HookArtifactConfig, DeployedHookAddress>;
  upperHook: Artifact<HookArtifactConfig, DeployedHookAddress>;
}

export interface ArbL2ToL1HookArtifactConfig {
  type: typeof HookType.ARB_L2_TO_L1;
  arbSys: string;
  bridge?: string;
  destinationDomain: number;
  childHook: Artifact<HookArtifactConfig, DeployedHookAddress>;
}

export interface CcipHookArtifactConfig {
  type: typeof HookType.CCIP;
  destinationDomain: number;
}

export interface OpStackHookArtifactConfig extends Omit<
  OpStackHookConfig,
  'destinationChain'
> {
  destinationDomain: number;
}

export interface DelayedFlowRouterHookArtifactConfig extends Omit<
  DelayedFlowRouterHookConfig,
  'remoteIsms'
> {
  remoteIsms?: Record<number, string>;
}

export interface HookArtifactConfigs {
  [HookType.CUSTOM]: CustomHookConfig;
  [HookType.MERKLE_TREE]: MerkleTreeHookConfig;
  [HookType.INTERCHAIN_GAS_PAYMASTER]: IgpHookConfig;
  [HookType.AGGREGATION]: AggregationHookArtifactConfig;
  [HookType.PROTOCOL_FEE]: ProtocolFeeHookConfig;
  [HookType.OP_STACK]: OpStackHookArtifactConfig;
  [HookType.ROUTING]: DomainRoutingHookArtifactConfig;
  [HookType.FALLBACK_ROUTING]: FallbackRoutingHookArtifactConfig;
  [HookType.AMOUNT_ROUTING]: AmountRoutingHookArtifactConfig;
  [HookType.PAUSABLE]: PausableHookConfig;
  [HookType.ARB_L2_TO_L1]: ArbL2ToL1HookArtifactConfig;
  [HookType.MAILBOX_DEFAULT]: MailboxDefaultHookConfig;
  [HookType.CCIP]: CcipHookArtifactConfig;
  [HookType.CCTP]: CctpHookConfig;
  [HookType.RATE_LIMITED]: RateLimitedHookConfig;
  [HookType.NET_FLOW_RATE_LIMITED]: NetFlowRateLimitedHookConfig;
  [HookType.DELAYED_FLOW_ROUTER]: DelayedFlowRouterHookArtifactConfig;
  [HookType.UNKNOWN]: UnknownHookConfig;
  [HookType.PREDICATE]: PredicateHookConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads any kind of Hook
 */
export type HookArtifactConfig = HookArtifactConfigs[HookType];

export type MutableHookArtifactConfig = Extract<
  HookArtifactConfig,
  { type: MutableHookType }
>;

export type DirectHookArtifactConfig = Exclude<
  HookArtifactConfig,
  | HookArtifactConfigs[typeof HookType.AGGREGATION]
  | HookArtifactConfigs[typeof HookType.ROUTING]
  | HookArtifactConfigs[typeof HookType.FALLBACK_ROUTING]
  | HookArtifactConfigs[typeof HookType.AMOUNT_ROUTING]
  | HookArtifactConfigs[typeof HookType.ARB_L2_TO_L1]
>;

export type DirectHookType = DirectHookArtifactConfig['type'];

export function isDirectHookArtifactConfig<T extends { type: HookType }>(
  config: T,
): config is Extract<T, { type: DirectHookType }> {
  switch (config.type) {
    case HookType.AGGREGATION:
    case HookType.ROUTING:
    case HookType.FALLBACK_ROUTING:
    case HookType.AMOUNT_ROUTING:
    case HookType.ARB_L2_TO_L1:
      return false;
    case HookType.CUSTOM:
    case HookType.MERKLE_TREE:
    case HookType.INTERCHAIN_GAS_PAYMASTER:
    case HookType.PROTOCOL_FEE:
    case HookType.OP_STACK:
    case HookType.PAUSABLE:
    case HookType.MAILBOX_DEFAULT:
    case HookType.CCIP:
    case HookType.CCTP:
    case HookType.RATE_LIMITED:
    case HookType.NET_FLOW_RATE_LIMITED:
    case HookType.DELAYED_FLOW_ROUTER:
    case HookType.UNKNOWN:
    case HookType.PREDICATE:
      return true;
    default:
      return throwUnhandledHookType(config, 'isDirectHookArtifactConfig');
  }
}

/**
 * Describes the configuration of deployed Hook
 */
export type DeployedHookArtifact = ArtifactDeployed<
  HookArtifactConfig,
  DeployedHookAddress
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of a Hook config
 */
export type IHookArtifactManager = IArtifactManager<
  HookType,
  HookArtifactConfigs,
  DeployedHookAddress
>;

/**
 * Raw hook artifact configs. Nested artifacts are constrained to on-chain states.
 */
export type RawHookArtifactConfigs = {
  [K in HookType]: ConfigOnChain<HookArtifactConfigs[K]>;
};

export type HookArtifactReaderFactories<D = DeployedHookAddress> = Partial<{
  [K in HookType]: () => ArtifactReader<RawHookArtifactConfigs[K], D>;
}>;

export type HookArtifactWriterFactories<D = DeployedHookAddress> = Partial<{
  [K in HookType]: () => ArtifactWriter<RawHookArtifactConfigs[K], D>;
}>;

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single hook artifact on chain
 */
export type RawHookArtifactConfig = RawHookArtifactConfigs[HookType];

/**
 * Describes a deployed hook before nested artifact expansion.
 */
export type DeployedRawHookArtifact = ArtifactDeployed<
  RawHookArtifactConfig,
  DeployedHookAddress
>;

function isProtocolFeeHookConfig(
  config: HookArtifactConfig,
): config is ProtocolFeeHookConfig {
  return config.type === HookType.PROTOCOL_FEE;
}

function hasUnreadableProtocolFeeMax(config: HookArtifactConfig): boolean {
  return (
    isProtocolFeeHookConfig(config) &&
    // CAST: Reflect.get requires an object argument; HookArtifactConfig is always an object here.
    Reflect.get(config, '__maxProtocolFeeUnknown') === true
  );
}

/**
 * Should be used to implement an object/closure or class that individually deploys
 * Hooks on chain
 */
export interface IRawHookArtifactManager extends IArtifactManager<
  HookType,
  RawHookArtifactConfigs,
  DeployedHookAddress
> {
  /**
   * Read any hook by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading hooks of unknown types.
   * @param address The on-chain address of the hook
   * @returns The artifact configuration and deployment data
   */
  readHook(address: string): Promise<DeployedRawHookArtifact>;
}

function formatUnhandledHookType(value: unknown): string {
  if (value && typeof value === 'object') {
    const hookType = Reflect.get(value, 'type');
    if (hookType !== undefined) return String(hookType);

    try {
      return JSON.stringify(value);
    } catch {
      const constructor = Reflect.get(value, 'constructor');
      const constructorName =
        typeof constructor === 'function'
          ? Reflect.get(constructor, 'name')
          : undefined;
      return typeof constructorName === 'string'
        ? `[object ${constructorName}]`
        : '[object]';
    }
  }

  return String(value);
}

function throwUnhandledHookType(value: unknown, context: string): never {
  throw new Error(
    `Unhandled hook type in ${context}: ${formatUnhandledHookType(value)}`,
  );
}

export class UnsupportedHookArtifactTypeError extends Error {
  constructor(
    public readonly hookType: string,
    public readonly protocol: ProtocolType,
  ) {
    super(
      `Unsupported hook artifact type ${hookType} for protocol ${protocol}`,
    );
    this.name = 'UnsupportedHookArtifactTypeError';
  }
}

export function throwUnsupportedHookType(
  hookType: string,
  protocol: ProtocolType,
): never {
  throw new UnsupportedHookArtifactTypeError(hookType, protocol);
}

// Hook Config Utilities

const logger: Logger = rootLogger.child({ module: 'hook-config-utils' });

/**
 * Converts HookConfig (Config API) to HookArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - IGP hooks: String chain names → numeric domain IDs for overhead/oracleConfig keys
 * - MerkleTree hooks: Pass through unchanged
 *
 * @param config The hook configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @returns Artifact wrapper around HookArtifactConfig suitable for artifact writers
 *
 * @example
 * ```typescript
 * // Config API format (user-facing)
 * const hookConfig: HookConfig = {
 *   type: 'interchainGasPaymaster',
 *   owner: '0x123...',
 *   overhead: {
 *     ethereum: 50000,
 *     polygon: 100000
 *   },
 *   oracleConfig: {
 *     ethereum: { gasPrice: '10', tokenExchangeRate: '1' },
 *     polygon: { gasPrice: '50', tokenExchangeRate: '1.5' }
 *   }
 * };
 *
 * // Convert to Artifact API format (internal)
 * const artifact = hookConfigToArtifact(hookConfig, chainLookup);
 * // artifact.config.overhead is now Record<number, number> with domain IDs as keys
 * // artifact.config.oracleConfig is now Record<number, {...}> with domain IDs as keys
 * ```
 */
export function hookConfigToArtifact(
  config: HookConfig,
  chainLookup: ChainLookup,
): ArtifactNew<HookArtifactConfig> {
  switch (config.type) {
    case HookType.INTERCHAIN_GAS_PAYMASTER: {
      // Handle IGP hooks - need to convert chain names to domain IDs
      const overhead: Record<number, number> = {};
      const oracleConfig: Record<number, GasOracleConfig> = {};
      const tokenOracleConfig: Record<
        string,
        Record<number, GasOracleConfig>
      > = {};

      // Convert overhead map from chain names to domain IDs
      for (const [chainName, value] of Object.entries(config.overhead)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (domainId === null) {
          logger.warn(
            `Skipping overhead config for unknown chain: ${chainName}. ` +
              `Chain not found in chain lookup.`,
          );
          continue;
        }
        overhead[domainId] = value;
      }

      // Convert oracleConfig map from chain names to domain IDs
      for (const [chainName, value] of Object.entries(config.oracleConfig)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (domainId === null) {
          logger.warn(
            `Skipping oracle config for unknown chain: ${chainName}. ` +
              `Chain not found in chain lookup.`,
          );
          continue;
        }
        oracleConfig[domainId] = value;
      }

      for (const [token, configs] of Object.entries(
        config.tokenOracleConfig ?? {},
      )) {
        const artifactConfigs: Record<number, GasOracleConfig> = {};
        for (const [chainName, value] of Object.entries(configs)) {
          const domainId = chainLookup.getDomainId(chainName);
          if (domainId === null) {
            logger.warn(
              `Skipping token oracle config for unknown chain: ${chainName}. ` +
                `Chain not found in chain lookup.`,
            );
            continue;
          }
          artifactConfigs[domainId] = value;
        }
        tokenOracleConfig[token] = artifactConfigs;
      }

      const artifactConfig: IgpHookConfig = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: config.owner,
        beneficiary: config.beneficiary,
        oracleKey: config.oracleKey,
        overhead,
        oracleConfig,
        contractVersion: config.contractVersion,
        quoteSigners: config.quoteSigners,
      };
      if (config.tokenOracleConfig !== undefined) {
        artifactConfig.tokenOracleConfig = tokenOracleConfig;
      }

      return {
        artifactState: ArtifactState.NEW,
        config: artifactConfig,
      };
    }

    case HookType.MERKLE_TREE:
      // MerkleTree hooks have identical structure between Config API and Artifact API
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: HookType.MERKLE_TREE,
        },
      };

    case HookType.UNKNOWN:
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: HookType.UNKNOWN,
        },
      };

    case HookType.PROTOCOL_FEE:
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: HookType.PROTOCOL_FEE,
          owner: config.owner,
          beneficiary: config.beneficiary,
          maxProtocolFee: config.maxProtocolFee,
          protocolFee: config.protocolFee,
        },
      };

    default: {
      return throwUnhandledHookType(config, 'hookConfigToArtifact');
    }
  }
}

/**
 * Determines if a new hook should be deployed instead of updating the existing one.
 * Deploy new hook if:
 * - Hook type changed
 * - Hook config changed (for immutable hooks like MerkleTree)
 *
 * Mutable hooks can be updated in-place.
 *
 * @param actual The current deployed hook configuration
 * @param expected The desired hook configuration
 * @returns true if a new hook should be deployed, false if existing can be updated
 */
export function shouldDeployNewHook(
  actual: HookArtifactConfig,
  expected: HookArtifactConfig,
): boolean {
  // Type changed - must deploy new
  if (actual.type !== expected.type) return true;

  // Normalize and compare configs
  const normalizedActual = normalizeConfig(actual);
  const normalizedExpected = normalizeConfig(expected);

  // Protocol fee is mutable except for its constructor-only maximum.
  if (expected.type === HookType.PROTOCOL_FEE) {
    assert(isProtocolFeeHookConfig(actual), 'expected protocolFee hook config');
    if (hasUnreadableProtocolFeeMax(actual)) {
      throw new Error(
        'Cannot compare protocolFee maxProtocolFee because the current hook does not expose a readable maxProtocolFee',
      );
    }
    return actual.maxProtocolFee !== expected.maxProtocolFee;
  }

  // Capacity can be updated, but duration is set in the constructor.
  if (
    actual.type === HookType.RATE_LIMITED &&
    expected.type === HookType.RATE_LIMITED
  ) {
    return actual.duration !== expected.duration;
  }

  if (isMutableHookConfig(expected)) {
    return false;
  }

  // Check mutability based on hook type
  switch (expected.type) {
    case HookType.CUSTOM:
    case HookType.MERKLE_TREE:
    case HookType.AGGREGATION:
    case HookType.OP_STACK:
    case HookType.AMOUNT_ROUTING:
    case HookType.ARB_L2_TO_L1:
    case HookType.MAILBOX_DEFAULT:
    case HookType.CCIP:
    case HookType.CCTP:
    case HookType.NET_FLOW_RATE_LIMITED:
    case HookType.DELAYED_FLOW_ROUTER:
    case HookType.PREDICATE:
      return !deepEquals(normalizedActual, normalizedExpected);

    case HookType.UNKNOWN:
      return false;

    default:
      return throwUnhandledHookType(expected, 'shouldDeployNewHook');
  }
}

/**
 * Merges current on-chain hook artifact with expected hook artifact.
 * Determines whether to deploy a new hook or update/reuse existing one.
 *
 * @param currentArtifact Current deployed hook artifact (from on-chain state)
 * @param expectedArtifact Expected hook artifact (desired configuration)
 * @returns Merged artifact - either NEW (deploy needed) or DEPLOYED (update/reuse)
 */
export function mergeHookArtifacts(
  currentArtifact: DeployedHookArtifact | undefined,
  expectedArtifact: ArtifactNew<HookArtifactConfig> | DeployedHookArtifact,
): ArtifactNew<HookArtifactConfig> | DeployedHookArtifact {
  const expectedConfig = expectedArtifact.config;

  // No current hook - return expected as-is
  if (!currentArtifact) {
    return expectedArtifact;
  }

  const currentConfig = currentArtifact.config;

  // Type changed or config requires new deployment
  if (shouldDeployNewHook(currentConfig, expectedConfig)) {
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  // Hook can be updated/reused
  // If expected is DEPLOYED (has address), use that address (switching to different deployed hook)
  // Otherwise use current address (updating current hook)
  const deployedAddress = isArtifactDeployed(expectedArtifact)
    ? expectedArtifact.deployed
    : currentArtifact.deployed;

  return {
    artifactState: ArtifactState.DEPLOYED,
    config: expectedConfig,
    deployed: deployedAddress,
  };
}

/**
 * Converts a DeployedHookArtifact to DerivedHookConfig format.
 * This handles the conversion between the new Artifact API and the old Config API.
 *
 * @param artifact The deployed hook artifact from the Artifact API
 * @param chainLookup Chain lookup interface for resolving domain IDs to chain names
 * @returns Hook configuration in Config API format with address
 */
export function hookArtifactToDerivedConfig(
  artifact: DeployedHookArtifact,
  chainLookup: ChainLookup,
): DerivedHookConfig {
  const config = artifact.config;
  const address = artifact.deployed.address;

  switch (config.type) {
    case HookType.INTERCHAIN_GAS_PAYMASTER: {
      // For IGP hooks, convert domain IDs back to chain names
      const overhead: Record<string, number> = {};
      const oracleConfig: Record<string, GasOracleConfig> = {};
      const tokenOracleConfig: Record<
        string,
        Record<string, GasOracleConfig>
      > = {};

      for (const [domainIdStr, value] of Object.entries(config.overhead)) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains (already warned during read if needed)
          continue;
        }
        overhead[chainName] = value;
      }

      for (const [domainIdStr, value] of Object.entries(config.oracleConfig)) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains
          continue;
        }
        oracleConfig[chainName] = value;
      }

      for (const [token, configs] of Object.entries(
        config.tokenOracleConfig ?? {},
      )) {
        const derivedConfigs: Record<string, GasOracleConfig> = {};
        for (const [domainIdString, value] of Object.entries(configs)) {
          const chainName = chainLookup.getChainName(Number(domainIdString));
          if (!chainName) continue;
          derivedConfigs[chainName] = value;
        }
        tokenOracleConfig[token] = derivedConfigs;
      }

      const derivedConfig: WithAddress<IgpHookModuleConfig> = {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: config.owner,
        beneficiary: config.beneficiary,
        oracleKey: config.oracleKey,
        overhead,
        oracleConfig,
        contractVersion: config.contractVersion,
        quoteSigners: config.quoteSigners,
        address,
      };
      if (config.tokenOracleConfig !== undefined) {
        derivedConfig.tokenOracleConfig = tokenOracleConfig;
      }

      return derivedConfig;
    }

    case HookType.MERKLE_TREE:
      // For MerkleTree hooks, just add the address
      return {
        ...config,
        address,
      };

    case HookType.UNKNOWN:
      return {
        type: HookType.UNKNOWN,
        address,
      };

    case HookType.PROTOCOL_FEE:
      return {
        type: HookType.PROTOCOL_FEE,
        owner: config.owner,
        beneficiary: config.beneficiary,
        maxProtocolFee: config.maxProtocolFee,
        protocolFee: config.protocolFee,
        address,
      };

    default: {
      return throwUnhandledHookType(config, 'hookArtifactToDerivedConfig');
    }
  }
}
