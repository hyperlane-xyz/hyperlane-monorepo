import {
  type FeeParams,
  FeeParamsType,
  type FeeStrategy,
  FeeStrategyType,
  bpsToRawFeeParams,
} from '@hyperlane-xyz/provider-sdk/fee';
import { assert, isNullish, setEquality } from '@hyperlane-xyz/utils';

import type { RouteDomainData } from '../accounts/fee.js';
import type { SvmFeeDataStrategy, SvmFeeParams } from '../codecs/fee.js';
import { FeeStrategyKind, h160ToSigner, signerToH160 } from './types.js';

// ====== Constants ======

const MAX_U64 = 2n ** 64n - 1n;
const ASSUMED_MAX_AMOUNT = 10n ** 8n;

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
      return bpsToRawFeeParams(params.bps, MAX_U64, ASSUMED_MAX_AMOUNT);
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

/** Pure leaf strategy types that have a direct on-chain kind mapping. */
export type PureLeafStrategyType = keyof typeof STRATEGY_TYPE_TO_KIND;

/**
 * Maps a provider-sdk FeeStrategyType to the on-chain FeeStrategyKind variant tag.
 * Only accepts pure leaf strategy types (excludes offchainQuotedLinear).
 */
export function feeStrategyTypeToKind(
  strategyType: PureLeafStrategyType,
): FeeStrategyKind {
  return STRATEGY_TYPE_TO_KIND[strategyType];
}

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
 * Handles all strategy types including offchainQuotedLinear (for routing routes).
 */
export function feeStrategyToOnChain(strategy: FeeStrategy): {
  feeData: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
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
      return {
        feeData: {
          kind: FeeStrategyKind.Linear,
          params: resolveRawFeeParams(strategy.params),
        },
        signers: strategy.quoteSigners.map(signerToH160),
      };

    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unhandled FeeStrategyType: ${String(_exhaustive)}`);
    }
  }
}

export function feeStrategiesEqual(a: FeeStrategy, b: FeeStrategy): boolean {
  if (a.type !== b.type) return false;

  const aParams = resolveRawFeeParams(a.params);
  const bParams = resolveRawFeeParams(b.params);
  if (
    aParams.maxFee !== bParams.maxFee ||
    aParams.halfAmount !== bParams.halfAmount
  ) {
    return false;
  }

  switch (a.type) {
    case FeeStrategyType.linear:
    case FeeStrategyType.regressive:
    case FeeStrategyType.progressive:
      return true;

    case FeeStrategyType.offchainQuotedLinear: {
      if (b.type !== FeeStrategyType.offchainQuotedLinear) return false;
      return setEquality(
        new Set(a.quoteSigners.map((s) => s.toLowerCase())),
        new Set(b.quoteSigners.map((s) => s.toLowerCase())),
      );
    }

    default: {
      const _exhaustive: never = a;
      throw new Error(`Unhandled FeeStrategyType: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Converts on-chain RouteDomainData to provider-sdk FeeStrategy.
 * If signers are present, returns offchainQuotedLinear (asserts Linear kind).
 * Otherwise maps the strategy kind directly.
 */
export function routeDataToFeeStrategy(route: RouteDomainData): FeeStrategy {
  const { maxFee, halfAmount } = route.feeData.params;
  const params: FeeParams = {
    type: FeeParamsType.raw,
    maxFee: maxFee.toString(),
    halfAmount: halfAmount.toString(),
  };

  if (!isNullish(route.signers)) {
    assert(
      route.feeData.kind === FeeStrategyKind.Linear,
      `offchainQuotedLinear requires Linear strategy, got kind ${route.feeData.kind}`,
    );
    return {
      type: FeeStrategyType.offchainQuotedLinear,
      params,
      quoteSigners: route.signers.map(h160ToSigner),
    };
  }

  const strategyType = STRATEGY_KIND_TO_TYPE[route.feeData.kind];
  assert(
    strategyType !== undefined,
    `Unknown strategy kind: ${route.feeData.kind}`,
  );
  return { type: strategyType, params };
}

/**
 * Computes the union of all offchainQuotedLinear signers across route strategies.
 * Used to set wildcard signers on the Routing/CC fee account.
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

/** Case-insensitive equality check for two H160 signer sets. */
export function h160SetEquality(a: Uint8Array[], b: Uint8Array[]): boolean {
  return setEquality(
    new Set(a.map((signer) => h160ToSigner(signer).toLowerCase())),
    new Set(b.map((signer) => h160ToSigner(signer).toLowerCase())),
  );
}
