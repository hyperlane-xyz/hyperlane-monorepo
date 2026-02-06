import assert from 'assert';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';
import { WarpRouteIds } from '../warpIds.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

interface RouteConfig<T> {
  base: T;
  bsc: T;
  ethereum: T;
  matchain: T;
}

type RouteChains = keyof RouteConfig<any>;

const owners: RouteConfig<string> = {
  base: '0x3941e287a5e815177E5eA909EDb357fc7F7738C5',
  bsc: '0x489145FABcc90d09feCa3285BDd0A64cB2FB8d8c',
  ethereum: '0x3941e287a5e815177E5eA909EDb357fc7F7738C5',
  matchain: '0x485f48CdCc2F27ACE7B4BE6398ef1dD5002b65F5',
};

const decimals: RouteConfig<number> = {
  base: 6,
  bsc: 18,
  ethereum: 6,
  matchain: 18,
};

// Calculate scale based on max decimals (18) - current decimals
const maxDecimals = Math.max(...Object.values(decimals));

function tokenConfig(decimals: number) {
  const scaleExp = maxDecimals - decimals;
  const scale = Math.pow(10, scaleExp);
  assert(scaleExp <= 15, `Scale exponent ${scaleExp} too large (max 15)`);
  assert(Number.isInteger(scale), 'Scale must be an integer but got: ' + scale);
  return {
    name: 'USDC',
    symbol: 'USDC',
    decimals,
    ...(scaleExp > 0 && {
      scale,
    }),
  };
}

const rebalancing = getUSDCRebalancingBridgesConfigFor(Object.keys(owners), [
  WarpRouteIds.MainnetCCTPV1,
]);

export async function getMatchainUSDCWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const config: RouteConfig<HypTokenRouterConfig> = {
    matchain: {
      ...routerConfig.matchain,
      owner: owners.matchain,
      type: TokenType.collateralFiat,
      token: '0x679Dc08cC3A4acFeea2f7CAFAa37561aE0b41Ce7', // Not in common tokens yet
      ...tokenConfig(decimals.matchain),
      ...rebalancing.matchain,
    },
    base: {
      ...routerConfig.base,
      owner: owners.base,
      type: TokenType.collateral,
      token: tokens.base.USDC,
      ...tokenConfig(decimals.base),
      ...rebalancing.base,
    },
    bsc: {
      ...routerConfig.bsc,
      owner: owners.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.USDC,
      ...tokenConfig(decimals.bsc),
      ...rebalancing.bsc,
    },
    ethereum: {
      ...routerConfig.ethereum,
      owner: owners.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDC,
      ...tokenConfig(decimals.ethereum),
      ...rebalancing.ethereum,
    },
  };
  return config as Record<RouteChains, HypTokenRouterConfig>;
}

export const getMatchainUSDCStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(
    owners as Record<RouteChains, string>,
  );
