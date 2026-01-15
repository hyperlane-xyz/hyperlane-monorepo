import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getFixedRoutingFeeConfig,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

const owners = {
  // Eni Safe
  ethereum: '0x409dcC6874919D2194236e2F10b403E15CC7F149',

  // ICAs controlled by Ethereum Safe
  arbitrum: '0x38C2c361E81C89e9cD0FD7f5c305e60C2A039054',
  base: '0x83bD81deFEC483194f7c5c8E161DFC535c794167',
  bsc: '0xb8d4b6B1f402Cf9C525e6c167B3Efa59BCb718A9',
  eni: '0xf0004476DDC8985C067b6BDf94a1759f7b230809',
  optimism: '0xd1219aef6eA190f6aD48525664C33ceE0169c7a8',
  polygon: '0x3211A1Fea94cd4000Bd82D7C9E9334E51938De1b',
} as const;

const WARP_FEE_BPS = 8n;

const usdcTokenAddresses = {
  arbitrum: tokens.arbitrum.USDC,
  base: tokens.base.USDC,
  bsc: tokens.bsc.USDC,
  ethereum: tokens.ethereum.USDC,
  optimism: tokens.optimism.USDC,
  polygon: tokens.polygon.USDC,
} as const;

const usdtTokenAddresses = {
  arbitrum: tokens.arbitrum.USDT,
  base: tokens.base.USDT,
  bsc: tokens.bsc.USDT,
  ethereum: tokens.ethereum.USDT,
  optimism: tokens.optimism.USDT,
  polygon: tokens.polygon.USDT,
} as const;

const usdcDecimals = {
  arbitrum: 6,
  base: 6,
  bsc: 18,
  ethereum: 6,
  eni: 6,
  optimism: 6,
  polygon: 6,
} as const;

const usdtDecimals = {
  arbitrum: 6,
  base: 6,
  bsc: 18,
  ethereum: 6,
  eni: 6,
  optimism: 6,
  polygon: 6,
} as const;

function getScaledTokenConfig(
  name: string,
  symbol: string,
  decimals: number,
  maxDecimals: number,
) {
  const scaleExp = maxDecimals - decimals;
  return {
    name,
    symbol,
    decimals,
    ...(scaleExp > 0 && { scale: Math.pow(10, scaleExp) }),
  };
}

export async function getEniEthWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const eni: HypTokenRouterConfig = {
    ...routerConfig.eni,
    owner: owners.eni,
    type: TokenType.synthetic,
    name: 'Ether',
    symbol: 'ETH',
    tokenFee: getFixedRoutingFeeConfig(
      getWarpFeeOwner('eni'),
      ['ethereum'],
      WARP_FEE_BPS,
    ),
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.native,
  };

  return {
    eni,
    ethereum,
  };
}

export async function getEniWbtcWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const eni: HypTokenRouterConfig = {
    ...routerConfig.eni,
    owner: owners.eni,
    type: TokenType.synthetic,
    name: 'Wrapped BTC',
    symbol: 'WBTC',
    tokenFee: getFixedRoutingFeeConfig(
      getWarpFeeOwner('eni'),
      ['ethereum'],
      WARP_FEE_BPS,
    ),
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
  };

  return {
    eni,
    ethereum,
  };
}

export async function getEniUsdcWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const rebalanceableChains = [
    'arbitrum',
    'base',
    'ethereum',
    'optimism',
    'polygon',
  ] as const;

  const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
    rebalanceableChains,
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const maxDecimals = 18;
  const allCollateralChains = [
    'arbitrum',
    'base',
    'bsc',
    'ethereum',
    'optimism',
    'polygon',
  ] as const;

  const configs: Array<[string, HypTokenRouterConfig]> = [];

  for (const chain of rebalanceableChains) {
    const rebalancingConfig = rebalancingConfigByChain[chain];
    const config: HypTokenRouterConfig = {
      ...routerConfig[chain],
      owner: owners[chain],
      type: TokenType.collateral,
      token: usdcTokenAddresses[chain],
      ...getScaledTokenConfig(
        'USD Coin',
        'USDC',
        usdcDecimals[chain],
        maxDecimals,
      ),
      ...rebalancingConfig,
    };
    configs.push([chain, config]);
  }

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: usdcTokenAddresses.bsc,
    ...getScaledTokenConfig('USD Coin', 'USDC', usdcDecimals.bsc, maxDecimals),
  };
  configs.push(['bsc', bsc]);

  const eni: HypTokenRouterConfig = {
    ...routerConfig.eni,
    owner: owners.eni,
    type: TokenType.synthetic,
    ...getScaledTokenConfig('USD Coin', 'USDC', usdcDecimals.eni, maxDecimals),
    tokenFee: getFixedRoutingFeeConfig(
      getWarpFeeOwner('eni'),
      allCollateralChains,
      WARP_FEE_BPS,
    ),
  };
  configs.push(['eni', eni]);

  return Object.fromEntries(configs);
}

export async function getEniUsdtWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const maxDecimals = 18;
  const allCollateralChains = [
    'arbitrum',
    'base',
    'bsc',
    'ethereum',
    'optimism',
    'polygon',
  ] as const;

  const configs: Array<[string, HypTokenRouterConfig]> = [];

  for (const chain of allCollateralChains) {
    const config: HypTokenRouterConfig = {
      ...routerConfig[chain],
      owner: owners[chain],
      type: TokenType.collateral,
      token: usdtTokenAddresses[chain],
      ...getScaledTokenConfig(
        'Tether USD',
        'USDT',
        usdtDecimals[chain],
        maxDecimals,
      ),
    };
    configs.push([chain, config]);
  }

  const eni: HypTokenRouterConfig = {
    ...routerConfig.eni,
    owner: owners.eni,
    type: TokenType.synthetic,
    ...getScaledTokenConfig(
      'Tether USD',
      'USDT',
      usdtDecimals.eni,
      maxDecimals,
    ),
    tokenFee: getFixedRoutingFeeConfig(
      getWarpFeeOwner('eni'),
      allCollateralChains,
      WARP_FEE_BPS,
    ),
  };
  configs.push(['eni', eni]);

  return Object.fromEntries(configs);
}
