import {
  ChainMap,
  CollateralTokenConfig,
  HypTokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

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

const usdcTokenAddresses: RouteConfig<string> = {
  base: tokens.base.USDC,
  bsc: tokens.bsc.USDC,
  ethereum: tokens.ethereum.USDC,
  matchain: '0x679Dc08cC3A4acFeea2f7CAFAa37561aE0b41Ce7', // Not in common tokens yet
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
  return {
    name: 'USDC',
    symbol: 'USDC',
    decimals,
    ...(maxDecimals !== decimals && {
      scale: Math.pow(10, maxDecimals - decimals),
    }),
  };
}

const chainConfigs: RouteConfig<CollateralTokenConfig> = {
  matchain: {
    type: TokenType.collateralFiat,
    token: usdcTokenAddresses.matchain,
    ...tokenConfig(decimals.matchain),
  },
  base: {
    type: TokenType.collateral,
    token: usdcTokenAddresses.base,
    ...tokenConfig(decimals.base),
  },
  ethereum: {
    type: TokenType.collateral,
    token: usdcTokenAddresses.ethereum,
    ...tokenConfig(decimals.ethereum),
  },
  bsc: {
    type: TokenType.collateral,
    token: usdcTokenAddresses.bsc,
    ...tokenConfig(decimals.bsc),
  },
};

export const getMatchainUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    Object.entries(chainConfigs).map(
      ([chain, config]): [RouteChains, HypTokenRouterConfig] => {
        return [
          chain as RouteChains,
          {
            ...routerConfig[chain],
            owner: owners[chain as RouteChains],
            ...config,
          },
        ];
      },
    ),
  );
};

export const getMatchainUSDCStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(
    owners as Record<RouteChains, string>,
  );
