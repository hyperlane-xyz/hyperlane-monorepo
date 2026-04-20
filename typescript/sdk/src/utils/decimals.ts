import { assert, objMap } from '@hyperlane-xyz/utils';

import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap } from '../types.js';

/**
 * Lossless scale representation using bigint.
 * On-chain values and internal comparisons always use this form.
 */
export type NormalizedScale = { numerator: bigint; denominator: bigint };

/**
 * Any scale variant the Zod schema can produce:
 * - `number` (e.g. `scale: 1000`)
 * - `{numerator: number, denominator: number}`
 * - `{numerator: bigint, denominator: bigint}`
 */
export type ScaleInput = TokenMetadata['scale'];

export const DEFAULT_SCALE: NormalizedScale = {
  numerator: 1n,
  denominator: 1n,
};

export type ScaleAlignment = {
  localAmount: bigint;
  messageAmount: bigint;
};

/**
 * Converts any accepted scale variant to NormalizedScale (bigint).
 */
export function normalizeScale(scale: ScaleInput | undefined): NormalizedScale {
  if (scale === undefined) return DEFAULT_SCALE;
  if (typeof scale === 'number') {
    return { numerator: BigInt(scale), denominator: 1n };
  }
  return {
    numerator: BigInt(scale.numerator),
    denominator: BigInt(scale.denominator),
  };
}

function assertValidScale(scale: NormalizedScale): void {
  assert(
    scale.numerator > 0n && scale.denominator > 0n,
    `Scale must be positive, got ${scale.numerator}/${scale.denominator}`,
  );
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  assert(denominator > 0n, 'Denominator must be positive');
  assert(numerator >= 0n, 'Numerator must be non-negative');
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function messageAmountFromLocal(
  localAmount: bigint,
  scale: ScaleInput | undefined,
): bigint {
  assert(localAmount >= 0n, 'Local amount must be non-negative');
  const normalized = normalizeScale(scale);
  assertValidScale(normalized);
  return (localAmount * normalized.numerator) / normalized.denominator;
}

export function localAmountFromMessage(
  messageAmount: bigint,
  scale: ScaleInput | undefined,
): bigint {
  assert(messageAmount >= 0n, 'Message amount must be non-negative');
  const normalized = normalizeScale(scale);
  assertValidScale(normalized);
  return (messageAmount * normalized.denominator) / normalized.numerator;
}

export function minLocalAmountForMessage(
  messageAmount: bigint,
  scale: ScaleInput | undefined,
): bigint {
  assert(messageAmount >= 0n, 'Message amount must be non-negative');
  const normalized = normalizeScale(scale);
  assertValidScale(normalized);
  return ceilDiv(messageAmount * normalized.denominator, normalized.numerator);
}

export function alignLocalAmountToMessage(
  localAmount: bigint,
  scale: ScaleInput | undefined,
): ScaleAlignment {
  assert(localAmount >= 0n, 'Local amount must be non-negative');
  const messageAmount = messageAmountFromLocal(localAmount, scale);
  if (messageAmount === 0n) {
    return {
      localAmount: 0n,
      messageAmount: 0n,
    };
  }

  return {
    localAmount: minLocalAmountForMessage(messageAmount, scale),
    messageAmount,
  };
}

/**
 * Compares two scale values for equality without precision loss.
 * Accepts any scale variant (number, {number,number}, {bigint,bigint}, undefined).
 * Uses cross-multiplication: a/b === c/d iff a*d === b*c
 */
export function scalesEqual(
  a: ScaleInput | undefined,
  b: ScaleInput | undefined,
): boolean {
  const na = normalizeScale(a);
  const nb = normalizeScale(b);
  return na.numerator * nb.denominator === nb.numerator * na.denominator;
}

/**
 * Verifies that scale configs across chains are mutually consistent.
 *
 * A warp route may use either convention:
 *   - Scale-up: 6-decimal chains carry scale > 1, max-decimal chain carries no scale
 *   - Scale-down: max-decimal chain carries scale < 1 ({num:1, den:N}), others carry no scale
 *
 * Both are valid as long as the effective message amount is identical for every chain:
 *   scale_A / scale_B == 10^(dec_B - dec_A)  for any pair (A, B)
 *
 * Equivalently (avoiding floating point): for a fixed reference chain R,
 *   scale_A.num * 10^dec_A * scale_R.den  ==  scale_R.num * 10^dec_R * scale_A.den
 *
 * This accepts precision loss from scale-down (e.g., BSC 18-decimal USDT
 * scaled to 6-decimal message encoding loses 12 digits of sub-unit precision).
 */
export function verifyScale(
  configMap: Map<string, TokenMetadata> | WarpRouteDeployConfigMailboxRequired,
): boolean {
  const chainDecimalConfigPairs =
    configMap instanceof Map
      ? Object.fromEntries(configMap.entries())
      : configMap;
  const entries = Object.entries(
    objMap(chainDecimalConfigPairs, (chain, config) => {
      assert(
        config.decimals != null,
        `Decimals must be defined for token config on chain ${chain}`,
      );
      return { decimals: config.decimals, scale: config.scale };
    }),
  );

  if (entries.length <= 1) return true;

  if (areDecimalsUniform(Object.fromEntries(entries))) {
    const [, refConfig] = entries[0];
    return entries.every(([, config]) =>
      scalesEqual(refConfig.scale, config.scale),
    );
  }

  // Pick the first chain as reference. For every other chain, verify pairwise:
  //   ref.scale.num * 10^ref.dec * chain.scale.den
  //     == chain.scale.num * 10^chain.dec * ref.scale.den
  const [, refConfig] = entries[0];
  const refNorm = normalizeScale(refConfig.scale);
  const refEffective = refNorm.numerator * 10n ** BigInt(refConfig.decimals);

  for (let i = 1; i < entries.length; i++) {
    const [, config] = entries[i];
    const norm = normalizeScale(config.scale);
    const effective = norm.numerator * 10n ** BigInt(config.decimals);

    // Cross-multiply to compare ratios without division:
    //   refEffective / refNorm.denominator == effective / norm.denominator
    //   => refEffective * norm.denominator == effective * refNorm.denominator
    if (refEffective * norm.denominator !== effective * refNorm.denominator) {
      return false;
    }
  }
  return true;
}

function areDecimalsUniform(
  configMap: ChainMap<{ decimals: number }>,
): boolean {
  const values = Object.values(configMap);
  const [first, ...rest] = values;
  for (const d of rest) {
    if (d.decimals !== first.decimals) {
      return false;
    }
  }
  return true;
}
