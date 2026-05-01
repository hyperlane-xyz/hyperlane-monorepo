import {
  type FeeParams,
  FeeParamsType,
  type FeeStrategy,
  FeeStrategyType,
} from '@hyperlane-xyz/provider-sdk/fee';
import { assert } from '@hyperlane-xyz/utils';

import type { SvmFeeDataStrategy, SvmFeeParams } from '../codecs/fee.js';
import { FeeStrategyKind } from './types.js';

// ====== Constants ======

const MAX_U64 = 2n ** 64n - 1n;
const MAX_BPS = 10_000n;
const BPS_PRECISION = 10_000n;
const ASSUMED_MAX_AMOUNT = 10n ** 8n;

// ====== BPS <-> Raw Conversion ======

function bpsToRawParams(bps: number): { maxFee: bigint; halfAmount: bigint } {
  assert(bps > 0, 'bps must be > 0');
  const maxFee = MAX_U64 / ASSUMED_MAX_AMOUNT;
  const scaledBps = BigInt(Math.round(bps * Number(BPS_PRECISION)));
  const halfAmount = ((maxFee / 2n) * MAX_BPS * BPS_PRECISION) / scaledBps;
  return { maxFee, halfAmount };
}

/**
 * Resolves provider-sdk FeeParams to raw bigint maxFee/halfAmount.
 * For 'raw' type: converts strings directly.
 * For 'bps' type: computes u64-safe raw params from bps value.
 */
export function resolveRawFeeParams(params: FeeParams): SvmFeeParams {
  switch (params.type) {
    case FeeParamsType.raw:
      return {
        maxFee: BigInt(params.maxFee),
        halfAmount: BigInt(params.halfAmount),
      };
    case FeeParamsType.bps:
      return bpsToRawParams(params.bps);
    default: {
      const _exhaustive: never = params;
      throw new Error(`Unknown FeeParams type: ${String(_exhaustive)}`);
    }
  }
}

// ====== On-chain <-> Provider-SDK Mapping ======

const STRATEGY_KIND_TO_TYPE = {
  [FeeStrategyKind.Linear]: FeeStrategyType.linear,
  [FeeStrategyKind.Regressive]: FeeStrategyType.regressive,
  [FeeStrategyKind.Progressive]: FeeStrategyType.progressive,
} as const;

const STRATEGY_TYPE_TO_KIND = {
  [FeeStrategyType.linear]: FeeStrategyKind.Linear,
  [FeeStrategyType.regressive]: FeeStrategyKind.Regressive,
  [FeeStrategyType.progressive]: FeeStrategyKind.Progressive,
} as const;

/**
 * Converts on-chain SvmFeeDataStrategy to provider-sdk FeeStrategy.
 * Used by leaf fee readers to produce the artifact config.
 */
export function leafDataToFeeStrategy(
  feeData: SvmFeeDataStrategy,
): FeeStrategy {
  const strategyType = STRATEGY_KIND_TO_TYPE[feeData.kind];
  assert(
    strategyType !== undefined,
    `Unknown FeeStrategyKind: ${feeData.kind}`,
  );
  return {
    type: strategyType,
    params: {
      type: FeeParamsType.raw,
      maxFee: feeData.params.maxFee.toString(),
      halfAmount: feeData.params.halfAmount.toString(),
    },
  };
}

/**
 * Converts provider-sdk FeeStrategy to on-chain SvmFeeDataStrategy + optional signers.
 * Used by leaf fee writers to produce the on-chain encoding.
 */
export function feeStrategyToOnChain(strategy: FeeStrategy): {
  feeData: SvmFeeDataStrategy;
  signers: null;
} {
  switch (strategy.type) {
    case FeeStrategyType.linear:
    case FeeStrategyType.regressive:
    case FeeStrategyType.progressive: {
      const kind = STRATEGY_TYPE_TO_KIND[strategy.type];
      return {
        feeData: { kind, params: resolveRawFeeParams(strategy.params) },
        signers: null,
      };
    }

    case FeeStrategyType.offchainQuotedLinear:
      throw new Error(
        'offchainQuotedLinear not supported in leaf feeStrategyToOnChain — use dedicated writer',
      );

    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unhandled FeeStrategyType: ${String(_exhaustive)}`);
    }
  }
}
