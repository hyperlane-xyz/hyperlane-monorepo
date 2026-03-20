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

export function verifyScale(
  configMap: Map<string, TokenMetadata> | WarpRouteDeployConfigMailboxRequired,
): boolean {
  const chainDecimalConfigPairs =
    configMap instanceof Map
      ? Object.fromEntries(configMap.entries())
      : configMap;
  const decimalsByChain = objMap(chainDecimalConfigPairs, (chain, config) => {
    assert(
      config.decimals,
      `Decimals must be defined for token config on chain ${chain}`,
    );

    return { decimals: config.decimals, scale: config.scale };
  });

  if (!areDecimalsUniform(decimalsByChain)) {
    const maxDecimals = Math.max(
      ...Object.values(decimalsByChain).map((config) => config.decimals!),
    );

    for (const [_, config] of Object.entries(decimalsByChain)) {
      if (config.decimals) {
        const calculatedScale: NormalizedScale = {
          numerator: 10n ** BigInt(maxDecimals - config.decimals),
          denominator: 1n,
        };

        if (!scalesEqual(calculatedScale, config.scale)) {
          return false;
        }
      }
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
