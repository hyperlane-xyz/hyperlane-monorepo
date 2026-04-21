import {
  FeeStrategyType,
  type FeeStrategy,
} from '@hyperlane-xyz/provider-sdk/fee';

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
  const base = {
    maxFee: maxFee.toString(),
    halfAmount: halfAmount.toString(),
  };

  if (route.signers !== null && route.signers.length > 0) {
    return {
      type: FeeStrategyType.offchainQuotedLinear,
      ...base,
      quoteSigners: route.signers.map(h160ToSigner),
    };
  }

  switch (route.feeData.kind) {
    case FeeStrategyKind.Linear:
      return { type: FeeStrategyType.linear, ...base };
    case FeeStrategyKind.Regressive:
      return { type: FeeStrategyType.regressive, ...base };
    case FeeStrategyKind.Progressive:
      return { type: FeeStrategyType.progressive, ...base };
    default: {
      const _exhaustive: never = route.feeData;
      throw new Error(`Unknown strategy kind: ${_exhaustive}`);
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
  const params = {
    maxFee: BigInt(strategy.maxFee),
    halfAmount: BigInt(strategy.halfAmount),
  };

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
