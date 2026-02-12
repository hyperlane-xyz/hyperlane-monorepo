import { assert, objMap } from '@hyperlane-xyz/utils';

import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap } from '../types.js';

type Scale =
  | number
  | string
  | { numerator: number | string; denominator: number | string };

/**
 * Converts a scale value (number, string, or {numerator, denominator}) to a
 * scalar number for comparison. Returns 1 if scale is undefined.
 */
export function scaleToScalar(scale?: Scale): number {
  if (scale === undefined) return 1;
  if (typeof scale === 'number') return scale;
  if (typeof scale === 'string') return Number(scale);

  const numerator =
    typeof scale.numerator === 'string'
      ? Number(scale.numerator)
      : scale.numerator;
  const denominator =
    typeof scale.denominator === 'string'
      ? Number(scale.denominator)
      : scale.denominator;
  return numerator / denominator;
}

export function verifyScale(
  configMap: Map<string, TokenMetadata> | WarpRouteDeployConfigMailboxRequired,
): boolean {
  const chainDecimalConfigPairs =
    configMap instanceof Map
      ? Object.fromEntries(configMap.entries())
      : configMap;
  const decimalsByChain: ChainMap<{
    decimals: number;
    scale?: Scale;
  }> = objMap(chainDecimalConfigPairs, (chain, config) => {
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
        const calculatedScale = 10 ** (maxDecimals - config.decimals);

        if (calculatedScale !== scaleToScalar(config.scale)) {
          return false;
        }
      }
    }
  }
  return true;
}

function areDecimalsUniform(
  configMap: ChainMap<{
    decimals: number;
    scale?:
      | number
      | string
      | { numerator: number | string; denominator: number | string };
  }>,
): boolean {
  const values = [...Object.values(configMap)];
  const [first, ...rest] = values;
  for (const d of rest) {
    if (d.decimals !== first.decimals) {
      return false;
    }
  }
  return true;
}
