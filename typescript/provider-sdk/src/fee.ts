import { ArtifactDeployed, IArtifactManager } from './artifact.js';

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
// Direct fee types (linear, regressive, progressive, offchainQuotedLinear)
// are identical between Config API and Artifact API so they are reused directly.

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
  knownRoutersPerDomain: Record<number, Record<number, Set<string>>>;
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
