import {
  Logger,
  assert,
  deepEquals,
  isNullish,
  normalizeConfig,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  IArtifactManager,
  isArtifactDeployed,
} from './artifact.js';
import { ChainLookup } from './chain.js';

// These fee types model fees as a single contract/program with internal routing,
// unlike the EVM implementation where RoutingFee and CrossCollateralRoutingFee
// deploy separate fee contracts per destination domain. The upcoming SVM fee
// program will handle all routing internally via PDAs within one program, and
// these multi-VM types follow that single-entity model to avoid the complexity
// of supporting both approaches simultaneously. This will be unified later to
// support both models under a single interface.

// ====== Strategy Types (shared between Config API and Artifact API) ======

export const FeeStrategyType = {
  linear: 'LinearFee',
  regressive: 'RegressiveFee',
  progressive: 'ProgressiveFee',
  offchainQuotedLinear: 'OffchainQuotedLinearFee',
} as const;

export type FeeStrategyType =
  (typeof FeeStrategyType)[keyof typeof FeeStrategyType];

export const FeeParamsType = {
  bps: 'bps',
  raw: 'raw',
} as const;

export type FeeParamsType = (typeof FeeParamsType)[keyof typeof FeeParamsType];

export type FeeParams =
  | {
      type: typeof FeeParamsType.bps;
      bps: number;
      maxFee?: string;
      halfAmount?: string;
    }
  | { type: typeof FeeParamsType.raw; maxFee: string; halfAmount: string };

export interface LinearFeeStrategy {
  type: typeof FeeStrategyType.linear;
  params: FeeParams;
}

export interface RegressiveFeeStrategy {
  type: typeof FeeStrategyType.regressive;
  params: FeeParams;
}

export interface ProgressiveFeeStrategy {
  type: typeof FeeStrategyType.progressive;
  params: FeeParams;
}

export interface OffchainQuotedLinearFeeStrategy {
  type: typeof FeeStrategyType.offchainQuotedLinear;
  params: FeeParams;
  quoteSigners: string[];
}

export type FeeStrategy =
  | LinearFeeStrategy
  | RegressiveFeeStrategy
  | ProgressiveFeeStrategy
  | OffchainQuotedLinearFeeStrategy;

export const FeeType = {
  linear: 'LinearFee',
  regressive: 'RegressiveFee',
  progressive: 'ProgressiveFee',
  offchainQuotedLinear: 'OffchainQuotedLinearFee',
  routing: 'RoutingFee',
  crossCollateralRouting: 'CrossCollateralRoutingFee',
} as const;

export type FeeType = (typeof FeeType)[keyof typeof FeeType];

// ====== Config API Types (chain names as keys) ======

export interface BaseFeeConfig {
  owner: string;
  beneficiary: string;
  /**
   * Address of the asset the fee program receives. Populated by the warp
   * orchestrator at deploy/update time from the paired warp route's
   * settlement asset (see `resolveFeeTokenFromWarpArtifactConfig`). Undefined
   * for native warps and for fee programs that are not paired with a
   * token-bearing warp.
   *
   * Read paths may leave this undefined on protocols that don't persist the
   * fee asset on-chain. On such protocols, the orchestrator re-populates this
   * field on every write call.
   */
  token?: string;
}

export interface LinearFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.linear;
  params: FeeParams;
}

export interface RegressiveFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.regressive;
  params: FeeParams;
}

export interface ProgressiveFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.progressive;
  params: FeeParams;
}

export interface OffchainQuotedLinearFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.offchainQuotedLinear;
  params: FeeParams;
  quoteSigners: string[];
}

export interface RoutingFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.routing;
  routes: Record<string, FeeStrategy>;
}

export interface CrossCollateralRoutingFeeConfig extends BaseFeeConfig {
  type: typeof FeeType.crossCollateralRouting;
  routes: Record<string, Record<string, FeeStrategy>>;
}

export type FeeConfig =
  | LinearFeeConfig
  | RegressiveFeeConfig
  | ProgressiveFeeConfig
  | OffchainQuotedLinearFeeConfig
  | RoutingFeeConfig
  | CrossCollateralRoutingFeeConfig;

// ====== Derived Fee Config Types ======
// Resolved types returned by feeArtifactToDerivedConfig — bigint fields
// are resolved from on-chain raw params, bps is reverse-computed.

export type LeafFeeType =
  | typeof FeeType.linear
  | typeof FeeType.regressive
  | typeof FeeType.progressive;

export interface DerivedLeafFeeConfig {
  type: LeafFeeType;
  token: string;
  owner: string;
  beneficiary: string;
  maxFee: bigint;
  halfAmount: bigint;
  bps: number;
  address: string;
}

export interface DerivedOffchainQuotedLinearFeeConfig {
  type: typeof FeeType.offchainQuotedLinear;
  token: string;
  owner: string;
  beneficiary: string;
  maxFee: bigint;
  halfAmount: bigint;
  bps: number;
  quoteSigners: string[];
  address: string;
}

export interface DerivedRoutingFeeConfig {
  type: typeof FeeType.routing;
  token: string;
  owner: string;
  beneficiary: string;
  feeContracts: Record<string, DerivedFeeConfig>;
  address: string;
}

export interface DerivedCrossCollateralRoutingFeeConfig {
  type: typeof FeeType.crossCollateralRouting;
  owner: string;
  beneficiary: string;
  feeContracts: Record<string, Record<string, DerivedFeeConfig>>;
  address: string;
}

export type DerivedFeeConfig =
  | DerivedLeafFeeConfig
  | DerivedOffchainQuotedLinearFeeConfig
  | DerivedRoutingFeeConfig
  | DerivedCrossCollateralRoutingFeeConfig;

// ====== Artifact API Types (domain IDs as keys) ======
// Direct fee types (linear, regressive, progressive) are identical
// between Config API and Artifact API so they are reused directly.

export interface RoutingFeeArtifactConfig extends BaseFeeConfig {
  type: typeof FeeType.routing;
  routes: Record<number, FeeStrategy>;
}

export interface CrossCollateralRoutingFeeArtifactConfig extends BaseFeeConfig {
  type: typeof FeeType.crossCollateralRouting;
  routes: Record<number, Record<string, FeeStrategy>>;
}

export type FeeArtifactConfigs = {
  [FeeType.linear]: LinearFeeConfig;
  [FeeType.regressive]: RegressiveFeeConfig;
  [FeeType.progressive]: ProgressiveFeeConfig;
  [FeeType.offchainQuotedLinear]: OffchainQuotedLinearFeeConfig;
  [FeeType.routing]: RoutingFeeArtifactConfig;
  [FeeType.crossCollateralRouting]: CrossCollateralRoutingFeeArtifactConfig;
};

export type FeeArtifactConfig = FeeArtifactConfigs[FeeType];

export interface DeployedFeeAddress {
  address: string;
}

export type DeployedFeeArtifact = ArtifactDeployed<
  FeeArtifactConfig,
  DeployedFeeAddress
>;

export interface FeeReadContext {
  knownRoutersPerDomain: Record<number, Set<string>>;
}

export interface IRawFeeArtifactManager extends IArtifactManager<
  FeeType,
  FeeArtifactConfigs,
  DeployedFeeAddress
> {
  readFee(
    address: string,
    context: FeeReadContext,
  ): Promise<DeployedFeeArtifact>;
}

// ====== Fee Params Utilities ======

export const MAX_BPS = 10_000n;
export const BPS_PRECISION = 10_000n;
export const MAX_BPS_DECIMALS = 4;

/** Returns true if bps has at most MAX_BPS_DECIMALS decimal places. */
export function isBpsPrecisionValid(bps: number): boolean {
  const factor = 10 ** MAX_BPS_DECIMALS;
  const scaled = bps * factor;
  return Math.abs(Math.round(scaled) - scaled) <= 1e-9;
}

/** Validates that a bps value does not exceed MAX_BPS_DECIMALS decimal places. */
export function assertBpsPrecision(bps: number): void {
  assert(
    isBpsPrecisionValid(bps),
    `bps must have at most ${MAX_BPS_DECIMALS} decimal places, got ${bps}`,
  );
}

/**
 * Reverse-computes bps from raw fee params using scaled integer math.
 * Formula: scaledBps = (maxFee * MAX_BPS * BPS_PRECISION) / (halfAmount * 2)
 * Rounds to MAX_BPS_DECIMALS decimal places.
 */
export function computeBps(maxFee: bigint, halfAmount: bigint): number {
  assert(halfAmount !== 0n, 'halfAmount must be > 0');
  const scaledBps = (maxFee * MAX_BPS * BPS_PRECISION) / (halfAmount * 2n);
  const factor = 10 ** MAX_BPS_DECIMALS;
  return (
    Math.round((Number(scaledBps) / Number(BPS_PRECISION)) * factor) / factor
  );
}

/**
 * Converts bps to raw maxFee/halfAmount using a VM-specific max integer
 * and assumed max transfer amount.
 * maxFee = maxInt / assumedMaxAmount
 * halfAmount = ((maxFee / 2) * MAX_BPS * BPS_PRECISION) / scaledBps
 */
export function bpsToRawFeeParams(
  bps: number,
  maxInt: bigint,
  assumedMaxAmount: bigint,
): { maxFee: bigint; halfAmount: bigint } {
  assert(
    Number.isFinite(bps) && bps > 0,
    'bps must be > 0 to prevent division by zero',
  );
  assertBpsPrecision(bps);
  const maxFee = maxInt / assumedMaxAmount;
  const scaledBps = BigInt(Math.round(bps * Number(BPS_PRECISION)));
  const halfAmount = ((maxFee / 2n) * MAX_BPS * BPS_PRECISION) / scaledBps;
  assert(halfAmount <= maxInt, 'halfAmount must fit in max integer');
  return { maxFee, halfAmount };
}

/**
 * Resolves raw maxFee/halfAmount bigints from FeeParams.
 * For 'raw' type, converts string values directly.
 * For 'bps' type, asserts that maxFee/halfAmount overrides are present
 * (they must be resolved by the reader before reaching derived config).
 */
function resolveRawParams(params: FeeParams): {
  maxFee: bigint;
  halfAmount: bigint;
} {
  if (params.type === FeeParamsType.raw) {
    return {
      maxFee: BigInt(params.maxFee),
      halfAmount: BigInt(params.halfAmount),
    };
  }
  assert(
    params.maxFee !== undefined && params.halfAmount !== undefined,
    'bps FeeParams must have maxFee/halfAmount resolved for derived config',
  );
  return {
    maxFee: BigInt(params.maxFee),
    halfAmount: BigInt(params.halfAmount),
  };
}

function strategyToDerivedFeeConfig(
  strategy: FeeStrategy,
  token: string,
  owner: string,
  beneficiary: string,
  address: string,
): DerivedFeeConfig {
  const { maxFee, halfAmount } = resolveRawParams(strategy.params);
  const base = {
    token,
    owner,
    beneficiary,
    maxFee,
    halfAmount,
    bps: computeBps(maxFee, halfAmount),
    address,
  };

  switch (strategy.type) {
    case FeeStrategyType.linear:
    case FeeStrategyType.regressive:
    case FeeStrategyType.progressive:
      return { ...base, type: strategy.type };

    case FeeStrategyType.offchainQuotedLinear:
      return {
        ...base,
        type: strategy.type,
        quoteSigners: strategy.quoteSigners,
      };

    default: {
      const invalidStrategy: never = strategy;
      throw new Error(
        `Unhandled fee strategy type: ${JSON.stringify(invalidStrategy)}`,
      );
    }
  }
}

// ====== Config <-> Artifact Conversion ======

const feeLogger: Logger = rootLogger.child({ module: 'fee-config-utils' });

function convertRoutesToArtifact(
  routes: Record<string, FeeStrategy>,
  chainLookup: ChainLookup,
): Record<number, FeeStrategy> {
  const result: Record<number, FeeStrategy> = {};
  for (const [chainName, strategy] of Object.entries(routes)) {
    const domainId = chainLookup.getDomainId(chainName);
    if (isNullish(domainId)) {
      feeLogger.warn(
        `Skipping fee route for unknown chain: ${chainName}. ` +
          `Chain not found in chain lookup.`,
      );
      continue;
    }
    result[domainId] = strategy;
  }
  return result;
}

function convertCCRoutesToArtifact(
  routes: Record<string, Record<string, FeeStrategy>>,
  chainLookup: ChainLookup,
): Record<number, Record<string, FeeStrategy>> {
  const result: Record<number, Record<string, FeeStrategy>> = {};
  for (const [chainName, routerMap] of Object.entries(routes)) {
    const domainId = chainLookup.getDomainId(chainName);
    if (isNullish(domainId)) {
      feeLogger.warn(
        `Skipping CC fee route for unknown chain: ${chainName}. ` +
          `Chain not found in chain lookup.`,
      );
      continue;
    }
    result[domainId] = routerMap;
  }
  return result;
}

function convertRoutesToDerived(
  routes: Record<number, FeeStrategy>,
  chainLookup: ChainLookup,
): Record<string, FeeStrategy> {
  const result: Record<string, FeeStrategy> = {};
  for (const [domainIdStr, strategy] of Object.entries(routes)) {
    const domainId = parseInt(domainIdStr);
    const chainName = chainLookup.getChainName(domainId);
    if (!chainName) {
      feeLogger.warn(
        `Skipping fee route for unknown domain ID: ${domainId}. ` +
          `Domain not found in chain lookup.`,
      );
      continue;
    }
    result[chainName] = strategy;
  }
  return result;
}

function convertCCRoutesToDerived(
  routes: Record<number, Record<string, FeeStrategy>>,
  chainLookup: ChainLookup,
): Record<string, Record<string, FeeStrategy>> {
  const result: Record<string, Record<string, FeeStrategy>> = {};
  for (const [domainIdStr, routerMap] of Object.entries(routes)) {
    const domainId = parseInt(domainIdStr);
    const chainName = chainLookup.getChainName(domainId);
    if (!chainName) {
      feeLogger.warn(
        `Skipping CC fee route for unknown domain ID: ${domainId}. ` +
          `Domain not found in chain lookup.`,
      );
      continue;
    }
    result[chainName] = routerMap;
  }
  return result;
}

/**
 * Converts FeeConfig (Config API) to FeeArtifactConfig (Artifact API).
 * Chain names are converted to domain IDs for routing/CC routing fee types.
 * Direct fee types (linear, regressive, progressive) are passed through unchanged.
 */
export function feeConfigToArtifact(
  config: FeeConfig,
  chainLookup: ChainLookup,
): ArtifactNew<FeeArtifactConfig> {
  switch (config.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      return {
        artifactState: ArtifactState.NEW,
        config,
      };

    case FeeType.routing:
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: config.type,
          owner: config.owner,
          beneficiary: config.beneficiary,
          routes: convertRoutesToArtifact(config.routes, chainLookup),
        },
      };

    case FeeType.crossCollateralRouting:
      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: config.type,
          owner: config.owner,
          beneficiary: config.beneficiary,
          routes: convertCCRoutesToArtifact(config.routes, chainLookup),
        },
      };

    default: {
      const invalidConfig: never = config;
      throw new Error(
        `Unsupported fee type for artifact API: ${JSON.stringify(invalidConfig)}`,
      );
    }
  }
}

/**
 * Converts a DeployedFeeArtifact to DerivedFeeConfig format.
 * Flattens FeeParams to top-level maxFee/halfAmount/bps and converts
 * domain IDs back to chain names for routing/CC routing fee types.
 *
 * @param token Fee token address (native → zero, collateral → token, synthetic → zero placeholder)
 */
export function feeArtifactToDerivedConfig(
  artifact: DeployedFeeArtifact,
  chainLookup: ChainLookup,
  token: string,
): DerivedFeeConfig {
  const { config } = artifact;
  const address = artifact.deployed.address;

  switch (config.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive: {
      const { maxFee, halfAmount } = resolveRawParams(config.params);
      return {
        type: config.type,
        token,
        owner: config.owner,
        beneficiary: config.beneficiary,
        maxFee,
        halfAmount,
        bps: computeBps(maxFee, halfAmount),
        address,
      };
    }

    case FeeType.offchainQuotedLinear: {
      const { maxFee, halfAmount } = resolveRawParams(config.params);
      return {
        type: config.type,
        token,
        owner: config.owner,
        beneficiary: config.beneficiary,
        maxFee,
        halfAmount,
        bps: computeBps(maxFee, halfAmount),
        quoteSigners: config.quoteSigners,
        address,
      };
    }

    case FeeType.routing:
      return {
        type: config.type,
        token,
        owner: config.owner,
        beneficiary: config.beneficiary,
        feeContracts: objMap(
          convertRoutesToDerived(config.routes, chainLookup),
          (_, strategy) =>
            strategyToDerivedFeeConfig(
              strategy,
              token,
              config.owner,
              config.beneficiary,
              address,
            ),
        ),
        address,
      };

    case FeeType.crossCollateralRouting:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        feeContracts: objMap(
          convertCCRoutesToDerived(config.routes, chainLookup),
          (_, routerMap) =>
            objMap(routerMap, (__, strategy) =>
              strategyToDerivedFeeConfig(
                strategy,
                token,
                config.owner,
                config.beneficiary,
                address,
              ),
            ),
        ),
        address,
      };

    default: {
      const invalidConfig: never = config;
      throw new Error(`Unhandled fee type: ${JSON.stringify(invalidConfig)}`);
    }
  }
}

/**
 * Determines if a new fee should be deployed instead of updating the existing one.
 * Deploy new if fee type changed. For direct types (linear, regressive, progressive),
 * deploy new if config changed (immutable on EVM - constructor-set params).
 * Routing/CC routing types are mutable and can be updated in-place.
 */
export function shouldDeployNewFee(
  actual: FeeArtifactConfig,
  expected: FeeArtifactConfig,
): boolean {
  if (actual.type !== expected.type) return true;

  switch (expected.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      return !deepEquals(normalizeConfig(actual), normalizeConfig(expected));

    case FeeType.routing:
    case FeeType.crossCollateralRouting:
      return false;

    default: {
      const invalidConfig: never = expected;
      throw new Error(
        `Unhandled fee type in shouldDeployNewFee: ${JSON.stringify(invalidConfig)}`,
      );
    }
  }
}

/**
 * Returns a fee artifact config identical to the input except for the
 * `token` field, which is set to the provided value. Explicit per-variant
 * construction so future additions to any variant break this site at
 * compile time instead of being silently absorbed by a spread.
 */
export function withFeeAssetConfig(
  config: FeeArtifactConfig,
  token: string | undefined,
): FeeArtifactConfig {
  switch (config.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        params: config.params,
        token,
      };
    case FeeType.offchainQuotedLinear:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        params: config.params,
        quoteSigners: config.quoteSigners,
        token,
      };
    case FeeType.routing:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        routes: config.routes,
        token,
      };
    case FeeType.crossCollateralRouting:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        routes: config.routes,
        token,
      };
    default: {
      const invalidConfig: never = config;
      throw new Error(
        `Unsupported fee type for withFeeAssetConfig: ${JSON.stringify(invalidConfig)}`,
      );
    }
  }
}

/**
 * Merges current on-chain fee artifact with expected fee artifact.
 * Determines whether to deploy a new fee or update/reuse existing one.
 */
export function mergeFeeArtifacts(
  currentArtifact: DeployedFeeArtifact | undefined,
  expectedArtifact: ArtifactNew<FeeArtifactConfig> | DeployedFeeArtifact,
): ArtifactNew<FeeArtifactConfig> | DeployedFeeArtifact {
  const expectedConfig = expectedArtifact.config;

  if (!currentArtifact) {
    return expectedArtifact;
  }

  const currentConfig = currentArtifact.config;

  if (shouldDeployNewFee(currentConfig, expectedConfig)) {
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  const deployedAddress = isArtifactDeployed(expectedArtifact)
    ? expectedArtifact.deployed
    : currentArtifact.deployed;

  return {
    artifactState: ArtifactState.DEPLOYED,
    config: expectedConfig,
    deployed: deployedAddress,
  };
}
