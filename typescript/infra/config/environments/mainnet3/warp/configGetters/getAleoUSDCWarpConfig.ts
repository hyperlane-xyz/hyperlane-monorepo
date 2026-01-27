import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';

import { getUSDCRebalancingBridgesConfigFor } from './utils.js';

const owners = {
  aleo: '',
  arbitrum: '',
  avalanche: '',
  base: '',
  bsc: '',
  ethereum: '',
  optimism: '',
  polygon: '',
  solanamainnet: '',
};

export const getAleoUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfig = getUSDCRebalancingBridgesConfigFor(
    Object.keys(owners),
    [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast],
  );

  const defaultNameSymbolScale = {
    name: 'USD Coin',
    symbol: 'USDC',
    scale: 1000000000000,
  };

  const aleo: HypTokenRouterConfig = {
    ...routerConfig.aleo,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.aleo,
    type: TokenType.synthetic,
    gas: 60_000,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    ...rebalancingConfig.arbitrum,
  };

  const avalanche: HypTokenRouterConfig = {
    ...routerConfig.avalanche,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.avalanche,
    type: TokenType.collateral,
    token: tokens.avalanche.USDC,
    ...rebalancingConfig.avalanche,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    ...rebalancingConfig.base,
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    name: 'USD Coin',
    symbol: 'USDC',
    scale: 1,
    decimals: 18,
    owner: owners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc.USDC,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    ...rebalancingConfig.ethereum,
  };

  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    ...rebalancingConfig.optimism,
  };

  const polygon: HypTokenRouterConfig = {
    ...routerConfig.polygon,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.polygon,
    type: TokenType.collateral,
    token: tokens.polygon.USDC,
    ...rebalancingConfig.polygon,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    ...defaultNameSymbolScale,
    decimals: 6,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: 'EiUymjh3vJ2486ozY24s1A1YWXoH6QnSGjWuP95ph35G',
    gas: 300_000,
  };

  return {
    aleo,
    arbitrum,
    avalanche,
    base,
    bsc,
    ethereum,
    optimism,
    polygon,
    solanamainnet,
  };
};
