import type { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Scale factor for converting user-friendly float parameters to bigint.
 * Used for all scaled bigint arithmetic in flow-reactive strategies.
 * Example: alpha = 0.3 → alphaScale = 300n (0.3 * 1000)
 */
export const FLOW_SCALE = 1000n;

/**
 * Single transfer flow observation.
 * Represents a discrete collateral movement event on a chain.
 */
export type FlowRecord = {
  /** Chain where the flow occurred */
  chain: ChainName;
  /** Amount transferred: positive = collateral gained, negative = collateral lost */
  amount: bigint;
  /** Unix timestamp (milliseconds) when the flow was recorded */
  timestamp: number;
};

/**
 * Computed signal from a flow model.
 * Represents the model's assessment of current flow state on a chain.
 */
export type FlowSignal = {
  /** Chain being signaled */
  chain: ChainName;
  /** Magnitude of the signal (always positive, scaled by FLOW_SCALE) */
  magnitude: bigint;
  /** Direction of the signal: 'surplus' = excess collateral, 'deficit' = insufficient collateral */
  direction: 'surplus' | 'deficit';
};

/**
 * Time-windowed slice of flow history.
 * Used for windowed analysis of flow patterns.
 */
export type FlowWindow = {
  /** Start time of the window (Unix timestamp, milliseconds) */
  startTime: number;
  /** End time of the window (Unix timestamp, milliseconds) */
  endTime: number;
  /** Flow records within this window */
  records: FlowRecord[];
};

/**
 * Shared base configuration parameters for all flow-reactive strategies.
 * Defines common time-window and sampling behavior.
 */
export type FlowReactiveParams = {
  /** Size of the rolling time window in milliseconds */
  windowSizeMs: number;
  /** Minimum number of flow samples required before generating a signal */
  minSamplesForSignal: number;
  /** Number of cycles to run before first signal (allows model warmup) */
  coldStartCycles: number;
};

/**
 * EMA (Exponential Moving Average) flow model parameters.
 * Extends base params with EMA-specific smoothing configuration.
 */
export type EMAFlowParams = FlowReactiveParams & {
  /** Smoothing factor (0-1): higher = more weight to recent flows. User-friendly float. */
  alpha: number;
  /** Pre-scaled version of alpha: alphaScale = BigInt(Math.round(alpha * 1000)) */
  alphaScale: bigint;
};

/**
 * Velocity-based flow model parameters.
 * Extends base params with velocity and response scaling.
 */
export type VelocityFlowParams = FlowReactiveParams & {
  /** Multiplier for velocity magnitude. User-friendly float. */
  velocityMultiplier: number;
  /** Pre-scaled version: velocityMultiplierScale = BigInt(Math.round(velocityMultiplier * 1000)) */
  velocityMultiplierScale: bigint;
  /** Base response magnitude. User-friendly float. */
  baseResponse: number;
  /** Pre-scaled version: baseResponseScale = BigInt(Math.round(baseResponse * 1000)) */
  baseResponseScale: bigint;
};

/**
 * Threshold-based flow model parameters.
 * Extends base params with noise filtering and proportional control.
 */
export type ThresholdFlowParams = FlowReactiveParams & {
  /** Noise threshold below which flows are ignored. User-friendly float. */
  noiseThreshold: number;
  /** Pre-scaled version: noiseThresholdScale = BigInt(Math.round(noiseThreshold * 1000)) */
  noiseThresholdScale: bigint;
  /** Proportional gain for response scaling. User-friendly float. */
  proportionalGain: number;
  /** Pre-scaled version: proportionalGainScale = BigInt(Math.round(proportionalGain * 1000)) */
  proportionalGainScale: bigint;
};

/**
 * Acceleration-based flow model parameters.
 * Extends base params with acceleration weighting and damping.
 */
export type AccelerationFlowParams = FlowReactiveParams & {
  /** Weight for acceleration component in signal calculation. User-friendly float. */
  accelerationWeight: number;
  /** Pre-scaled version: accelerationWeightScale = BigInt(Math.round(accelerationWeight * 1000)) */
  accelerationWeightScale: bigint;
  /** Damping factor to reduce oscillation. User-friendly float. */
  damping: number;
  /** Pre-scaled version: dampingScale = BigInt(Math.round(damping * 1000)) */
  dampingScale: bigint;
};
