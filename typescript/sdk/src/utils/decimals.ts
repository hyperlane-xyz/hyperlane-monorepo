import {
  HypTokenRouterVirtualConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';

import { TokenMetadata } from '../token/types.js';

export function verifyScale(
  configMap:
    | Map<string, TokenMetadata>
    | WarpRouteDeployConfigMailboxRequired
    | Record<string, Partial<HypTokenRouterVirtualConfig>>,
): boolean {
  if (!areDecimalsUniform(configMap)) {
    const maxDecimals = Math.max(
      ...Object.values(configMap).map((config) => config.decimals!),
    );

    for (const [_, config] of Object.entries(configMap)) {
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
  configMap:
    | Map<string, TokenMetadata>
    | WarpRouteDeployConfigMailboxRequired
    | Record<string, Partial<HypTokenRouterVirtualConfig>>,
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
