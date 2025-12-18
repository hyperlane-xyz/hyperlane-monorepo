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
  bsc: '0x483AB386966D4B1691c4222029852E42e0B23B84',
  ethereum: '0x483AB386966D4B1691c4222029852E42e0B23B84',
  carrchain: '0x4BC8d6F19dB53dCA59FAE12Ed3F1201b1C8020dc', // ICA on ethereum
};

const decimals: RouteConfig<number> = {
  bsc: 18,
  ethereum: 8,
  carrchain: 8,
};

// Calculate scale based on max decimals (18) - current decimals
const maxDecimals = Math.max(...Object.values(decimals));

function tokenConfig(decimals: number) {
  const scaleExp = maxDecimals - decimals;
  const scale = Math.pow(10, scaleExp);
  assert(scaleExp <= 15, `Scale exponent ${scaleExp} too large (max 15)`);
  assert(Number.isInteger(scale), 'Scale must be an integer but got: ' + scale);
  return {
    name: 'Wrapped BTC',
    symbol: 'WBTC',
    decimals,
    ...(scaleExp > 0 && {
      scale,
    }),
  };
}

export async function getCarchainnWBTCWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const config: RouteConfig<HypTokenRouterConfig> = {
    bsc: {
      ...routerConfig.bsc,
      owner: owners.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.WBTC,
      ...tokenConfig(decimals.bsc),
    },
    ethereum: {
      ...routerConfig.ethereum,
      owner: owners.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.WBTC,
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
