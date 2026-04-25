import {
  FeeParamsKind,
  FeeStrategyType,
  type FeeParams,
  type FeeStrategy,
} from '@hyperlane-xyz/provider-sdk/fee';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import type {
  RouteDomainData,
  CrossCollateralRouteData,
} from '../accounts/fee.js';

import { FeeStrategyKind, h160ToSigner, signerToH160 } from './types.js';

type RouteData = RouteDomainData | CrossCollateralRouteData;

/**
 * Maps an on-chain route PDA (RouteDomain or CrossCollateralRoute) to a
 * provider-sdk FeeStrategy. Both share the same { feeData, signers } shape.
 */
export function routeDataToFeeStrategy(route: RouteData): FeeStrategy {
  const { maxFee, halfAmount } = route.feeData.params;
  const params: FeeParams = {
    kind: FeeParamsKind.raw,
    maxFee: maxFee.toString(),
    halfAmount: halfAmount.toString(),
  };

  if (!isNullish(route.signers)) {
    return {
      type: FeeStrategyType.offchainQuotedLinear,
      params,
      quoteSigners: route.signers.map(h160ToSigner),
    };
  }

  switch (route.feeData.kind) {
    case FeeStrategyKind.Linear:
      return { type: FeeStrategyType.linear, params };
    case FeeStrategyKind.Regressive:
      return { type: FeeStrategyType.regressive, params };
    case FeeStrategyKind.Progressive:
      return { type: FeeStrategyType.progressive, params };
    default: {
      const _exhaustive: never = route.feeData;
      throw new Error(`Unknown strategy kind: ${String(_exhaustive)}`);
    }
  }
}

const MAX_U64 = 2n ** 64n - 1n;
const MAX_BPS = 10_000n;
const BPS_PRECISION = 10_000n;
// maxFee = MAX_U64 / ASSUMED_MAX_AMOUNT.
// Chosen so that both maxFee and halfAmount fit in u64 for any valid bps
// (down to 0.0001 — the minimum 4-decimal precision).
// maxFee * 5 * 10^7 (worst-case halfAmount multiplier) must be <= MAX_U64,
// so ASSUMED_MAX_AMOUNT >= 5 * 10^7. We use 10^8 for round headroom.
const ASSUMED_MAX_AMOUNT = 10n ** 8n;

/**
 * Converts bps to raw maxFee/halfAmount using u64-safe math.
 * SVM fee program stores these as u64 but uses u256 internally for arithmetic.
 */
function bpsToRawParams(bps: number): { maxFee: bigint; halfAmount: bigint } {
  assert(bps > 0, 'bps must be > 0');
  const maxFee = MAX_U64 / ASSUMED_MAX_AMOUNT;
  const scaledBps = BigInt(Math.round(bps * Number(BPS_PRECISION)));
  const halfAmount = ((maxFee / 2n) * MAX_BPS * BPS_PRECISION) / scaledBps;
  return { maxFee, halfAmount };
}

/**
 * Resolves FeeParams to raw maxFee/halfAmount bigints.
 * For raw params, returns the values directly.
 * For bps params, always derives maxFee/halfAmount from bps
 * (any pre-populated maxFee/halfAmount on the bps variant are ignored).
 */
export function resolveRawFeeParams(params: FeeParams): {
  maxFee: bigint;
  halfAmount: bigint;
} {
  switch (params.kind) {
    case FeeParamsKind.raw:
      return {
        maxFee: BigInt(params.maxFee),
        halfAmount: BigInt(params.halfAmount),
      };
    case FeeParamsKind.bps:
      return bpsToRawParams(params.bps);
    default: {
      const _exhaustive: never = params;
      throw new Error(`Unknown FeeParams kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Maps a provider-sdk FeeStrategy to on-chain strategy kind + optional signers.
 */
export function feeStrategyToOnChain(strategy: FeeStrategy): {
  feeData: {
    kind: FeeStrategyKind;
    params: { maxFee: bigint; halfAmount: bigint };
  };
  signers: Uint8Array[] | null;
} {
  const params = resolveRawFeeParams(strategy.params);

  switch (strategy.type) {
    case FeeStrategyType.linear:
      return {
        feeData: { kind: FeeStrategyKind.Linear, params },
        signers: null,
      };
    case FeeStrategyType.regressive:
      return {
        feeData: { kind: FeeStrategyKind.Regressive, params },
        signers: null,
      };
    case FeeStrategyType.progressive:
      return {
        feeData: { kind: FeeStrategyKind.Progressive, params },
        signers: null,
      };
    case FeeStrategyType.offchainQuotedLinear:
      return {
        feeData: { kind: FeeStrategyKind.Linear, params },
        signers: strategy.quoteSigners.map(signerToH160),
      };
  }
}

/**
 * Computes the wildcard signer set as the union of all offchainQuotedLinear
 * route signers. Used for Routing and CrossCollateralRouting fee accounts.
 */
export function computeWildcardSignersFromStrategies(
  strategies: Iterable<FeeStrategy>,
): Uint8Array[] {
  const union = new Set<string>();
  for (const strategy of strategies) {
    if (strategy.type === FeeStrategyType.offchainQuotedLinear) {
      for (const s of strategy.quoteSigners) {
        union.add(s.toLowerCase());
      }
    }
  }
  return [...union].sort().map(signerToH160);
}
