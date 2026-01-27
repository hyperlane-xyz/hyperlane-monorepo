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
  aleo: 'aleo1hs5dstedw5u4nps77h54rnqcplagdst0tvcs2rhvuf8geuxzzvrs383dgs',
  arbitrum: '0x63C65aFC66C7247a3d43197744Da7F5838ACbf77',
  avalanche: '0x117f4a84f98b3C8BEF00a2371672031694C1Fa0A',
  base: '0xc88297c52BED07aecAec13BD3bB21647C319a73d',
  bsc: '0x157515A5Fe21FBC4e22479B5FA59344D0bC8bc58',
  ethereum: '0x738Bb9f27B5757797ba730390b4e43A9F4C2A011',
  optimism: '0x17e9199682D987D61784F8105018fa30e04Aa886',
  polygon: '0xac4AB5850b8dE9c07A2756c1c79266aB36183822',
  solanamainnet: 'ABJnd4eWexNte9GYy21ud5hvSwFKWedveP6GCFxXKkCw',
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
