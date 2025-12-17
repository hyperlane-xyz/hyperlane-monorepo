import assert from 'assert';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

interface RouteConfig<T> {
  bsc: T;
  ethereum: T;
  carrchain: T;
}

type RouteChains = keyof RouteConfig<any>;

const owners: RouteConfig<string> = {
  bsc: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  ethereum: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
  carrchain: '0x3Fb137161365f273Ebb8262a26569C117b6CBAfb',
};

const decimals: RouteConfig<number> = {
  bsc: 18,
  ethereum: 6,
  carrchain: 6,
};

// Calculate scale based on max decimals (18) - current decimals
const maxDecimals = Math.max(...Object.values(decimals));

function tokenConfig(decimals: number) {
  const scaleExp = maxDecimals - decimals;
  const scale = Math.pow(10, scaleExp);
  assert(scaleExp <= 15, `Scale exponent ${scaleExp} too large (max 15)`);
  assert(Number.isInteger(scale), 'Scale must be an integer but got: ' + scale);
  return {
    name: 'USD Coin',
    symbol: 'USDC',
    decimals,
    ...(scaleExp > 0 && {
      scale,
    }),
  };
}

export async function getCarchainnUSDCWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const config: RouteConfig<HypTokenRouterConfig> = {
    bsc: {
      ...routerConfig.bsc,
      owner: owners.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.USDC,
      ...tokenConfig(decimals.bsc),
    },
    ethereum: {
      ...routerConfig.ethereum,
      owner: owners.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDC,
      ...tokenConfig(decimals.ethereum),
    },
    carrchain: {
      ...routerConfig.carrchain,
      owner: owners.carrchain,
      type: TokenType.synthetic,
      ...tokenConfig(decimals.carrchain),
    },
  };
  return config as Record<RouteChains, HypTokenRouterConfig>;
}
