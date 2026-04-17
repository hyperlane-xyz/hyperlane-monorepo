import {
  Logger,
  deepEquals,
  isNullish,
  normalizeConfig,
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

// ====== Strategy Types (shared between Config API and Artifact API) ======

export const FeeStrategyType = {
  linear: 'linear',
  regressive: 'regressive',
  progressive: 'progressive',
} as const;

export type FeeStrategyType =
  (typeof FeeStrategyType)[keyof typeof FeeStrategyType];

export interface FeeParams {
  maxFee: string;
  halfAmount: string;
}

export interface LinearFeeStrategy extends FeeParams {
  type: typeof FeeStrategyType.linear;
}

export interface RegressiveFeeStrategy extends FeeParams {
  type: typeof FeeStrategyType.regressive;
}

export interface ProgressiveFeeStrategy extends FeeParams {
  type: typeof FeeStrategyType.progressive;
}

export type FeeStrategy =
  | LinearFeeStrategy
  | RegressiveFeeStrategy
  | ProgressiveFeeStrategy;

export const FeeType = {
  linear: 'linear',
  regressive: 'regressive',
  progressive: 'progressive',
  offchainQuotedLinear: 'offchainQuotedLinear',
  routing: 'routing',
  crossCollateralRouting: 'crossCollateralRouting',
} as const;

export type FeeType = (typeof FeeType)[keyof typeof FeeType];

// ====== Config API Types (chain names as keys) ======

export type BaseFeeConfig<T = {}> = {
  owner: string;
  beneficiary: string;
  quoteSigners?: Set<string>;
} & T;

export interface LinearFeeConfig extends BaseFeeConfig<FeeParams> {
  type: typeof FeeType.linear;
}

export interface RegressiveFeeConfig extends BaseFeeConfig<FeeParams> {
  type: typeof FeeType.regressive;
}

export interface ProgressiveFeeConfig extends BaseFeeConfig<FeeParams> {
  type: typeof FeeType.progressive;
}

export interface OffchainQuotedLinearFeeConfig extends BaseFeeConfig<FeeParams> {
  type: typeof FeeType.offchainQuotedLinear;
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

export type DerivedFeeConfig = FeeConfig & { address: string };

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

export interface FeeArtifactConfigs {
  linear: LinearFeeConfig;
  regressive: RegressiveFeeConfig;
  progressive: ProgressiveFeeConfig;
  offchainQuotedLinear: OffchainQuotedLinearFeeConfig;
  routing: RoutingFeeArtifactConfig;
  crossCollateralRouting: CrossCollateralRoutingFeeArtifactConfig;
}

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
    if (!chainName) continue;
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
    if (!chainName) continue;
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
          quoteSigners: config.quoteSigners,
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
          quoteSigners: config.quoteSigners,
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
 * Domain IDs are converted back to chain names for routing/CC routing fee types.
 */
export function feeArtifactToDerivedConfig(
  artifact: DeployedFeeArtifact,
  chainLookup: ChainLookup,
): DerivedFeeConfig {
  const { config } = artifact;
  const address = artifact.deployed.address;

  switch (config.type) {
    case FeeType.linear:
    case FeeType.regressive:
    case FeeType.progressive:
    case FeeType.offchainQuotedLinear:
      return { ...config, address };

    case FeeType.routing:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        quoteSigners: config.quoteSigners,
        routes: convertRoutesToDerived(config.routes, chainLookup),
        address,
      };

    case FeeType.crossCollateralRouting:
      return {
        type: config.type,
        owner: config.owner,
        beneficiary: config.beneficiary,
        quoteSigners: config.quoteSigners,
        routes: convertCCRoutesToDerived(config.routes, chainLookup),
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
