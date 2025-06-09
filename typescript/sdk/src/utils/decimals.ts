import { assert } from '@hyperlane-xyz/utils';

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
      ? Array.from(configMap.entries())
      : Object.entries(configMap);
  const decimalsByChain: ChainMap<{ decimals: number; scale?: number }> =
    Object.fromEntries(
      chainDecimalConfigPairs.map(([chain, config]) => {
        assert(
          config.decimals,
          `Decimals must be defined for token config on chain ${chain}`,
        );

        return [chain, { decimals: config.decimals, scale: config.scale }];
      }),
    );

  if (!areDecimalsUniform(decimalsByChain)) {
    const maxDecimals = Math.max(
      ...Object.values(decimalsByChain).map((config) => config.decimals!),
    );

    for (const [_, config] of Object.entries(decimalsByChain)) {
      if (config.decimals) {
        const calculatedScale = 10 ** (maxDecimals - config.decimals);
        if (
          (!config.scale && calculatedScale !== 1) ||
          (config.scale && calculatedScale !== config.scale)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function areDecimalsUniform(
  configMap: ChainMap<{ decimals: number; scale?: number }>,
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
