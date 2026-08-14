import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import {
  WARP_FEES_TURNKEY_OWNER,
  getWarpFeeOwner,
} from '../../governance/utils.js';
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
  tron: '0x5ac5e2cf5A0Bb92D1Ca5B8D02a069eC874294976',
} as const;

const WARP_FEE_BPS = 8;
// Moonpay offchain quote signer for the inter-collateral fees added on the USDT/eni route
const QUOTE_SIGNER = '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d';
const USDT_INTER_COLLATERAL_FEE_BPS = 5;

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
  tron: tokens.tron.USDT,
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
  tron: 6,
} as const;

// ENI's collateral routers use route-specific TokenBridgeCctpV2
// adapters for the fast CCTP path instead of the fast warp-router addresses.
const eniUsdcFastCctpAdapters = {
  arbitrum: '0xb0B8D4C6EF212D76d5079df5Ff7A0888A27e9b32',
  base: '0x584244d02b0fBf9054A5D5C9e9cE9A2E8adA0e28',
  ethereum: '0xEE4a09db2C25592C04b8b342CB89f9a7f5E20BD2',
  optimism: '0xb0B8D4C6EF212D76d5079df5Ff7A0888A27e9b32',
  polygon: '0x8dadbDE67eD0589d90cdE3C940045F10092AcC11',
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
    decimals: 18,
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
    decimals: 18,
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
    decimals: 8,
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
    decimals: 8,
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
    [WarpRouteIds.MainnetCCTPV2Standard],
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
    const allowedRebalancingBridges = Object.fromEntries(
      Object.entries(rebalancingConfig.allowedRebalancingBridges).map(
        ([destination, bridges]) => [
          destination,
          [...bridges, { bridge: eniUsdcFastCctpAdapters[chain] }],
        ],
      ),
    );
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
      allowedRebalancingBridges,
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
    'tron',
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
      tokenFee: getFixedRoutingFeeConfig(
        // Fee contracts on every leg except tron were rotated to Turnkey
        // treasury custody; tron still uses its WarpFees ICA.
        chain === 'tron' ? getWarpFeeOwner(chain) : WARP_FEES_TURNKEY_OWNER,
        allCollateralChains.filter((otherChain) => otherChain !== chain),
        USDT_INTER_COLLATERAL_FEE_BPS,
        undefined,
        // tron's fee contract charges the flat fee directly, without an offchain quote
        chain === 'tron' ? undefined : [QUOTE_SIGNER],
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
      // eni synthetic fee contract was rotated to Turnkey treasury custody.
      WARP_FEES_TURNKEY_OWNER,
      allCollateralChains,
      WARP_FEE_BPS,
    ),
  };
  configs.push(['eni', eni]);

  return Object.fromEntries(configs);
}

export async function getEni1PieceWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const eni: HypTokenRouterConfig = {
    ...routerConfig.eni,
    owner: owners.eni,
    type: TokenType.synthetic,
    name: 'OnePiece',
    symbol: '1Piece',
    decimals: 18,
    tokenFee: getFixedRoutingFeeConfig(
      getWarpFeeOwner('eni'),
      ['bsc'],
      WARP_FEE_BPS,
    ),
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc['1Piece'],
    decimals: 18,
    name: 'OnePiece',
    symbol: '1Piece',
  };

  return {
    eni,
    bsc,
  };
}
