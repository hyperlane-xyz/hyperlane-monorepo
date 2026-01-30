import { assert, objMap } from '@hyperlane-xyz/utils';

import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';
import { ChainMap } from '../types.js';

export function verifyScale(
  configMap: Map<string, TokenMetadata> | WarpRouteDeployConfigMailboxRequired,
): boolean {
  const chainDecimalConfigPairs =
    configMap instanceof Map
      ? Object.fromEntries(configMap.entries())
      : configMap;
  const decimalsByChain: ChainMap<{
    decimals: number;
    scale?:
      | number
      | string
      | { numerator: number | string; denominator: number | string };
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

        // Convert scale to scalar value for comparison
        let scaleValue: number;
        if (config.scale === undefined) {
          scaleValue = 1;
        } else if (typeof config.scale === 'number') {
          scaleValue = config.scale;
        } else if (typeof config.scale === 'string') {
          scaleValue = Number(config.scale);
        } else {
          const numerator =
            typeof config.scale.numerator === 'string'
              ? Number(config.scale.numerator)
              : config.scale.numerator;
          const denominator =
            typeof config.scale.denominator === 'string'
              ? Number(config.scale.denominator)
              : config.scale.denominator;
          scaleValue = numerator / denominator;
        }

        if (calculatedScale !== scaleValue) {
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
