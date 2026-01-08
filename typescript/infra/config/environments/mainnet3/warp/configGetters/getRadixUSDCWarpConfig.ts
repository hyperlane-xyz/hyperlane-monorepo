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

import { getRebalancingBridgesConfigFor } from './utils.js';

const owners = {
  ethereum: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  arbitrum: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  base: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  bnb: '0xA365Bf3Da1f1B01E2a80f9261Ec717B305b2Eb8F',
  radix: 'account_rdx1280taxhhnuek02y59yapsg4kjtux954qkyufpwmy4dlfcxdrjzr7fj',
  solanamainnet: 'GvjSzPttfE3dimBFZMKFhg7Yq3C5Jz17SrpE1L4nbR2F',
};

export const getRadixUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const rebalancingConfig = getRebalancingBridgesConfigFor(
    Object.keys(owners),
    [WarpRouteIds.MainnetCCTPV1],
  );

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    decimals: 6,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    ...rebalancingConfig.ethereum,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    decimals: 6,
    owner: owners.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    ...rebalancingConfig.arbitrum,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    decimals: 6,
    owner: owners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    ...rebalancingConfig.base,
  };

  const radix: HypTokenRouterConfig = {
    ...routerConfig.radix,
    owner: owners.radix,
    type: TokenType.synthetic,
    symbol: 'hUSDC',
    name: 'Hyperlane USD Coin',
    gas: 30_000_000,
    decimals: 6,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    decimals: 6,
    owner: owners.solanamainnet,
    type: TokenType.collateral,
    token: tokens.solanamainnet.USDC,
    foreignDeployment: 'mSjeF19MEyUto4RejyPeL6SGb2eDevNfYESaHBeQb9z',
    gas: 300_000,
  };

  return {
    arbitrum,
    base,
    ethereum,
    radix,
    solanamainnet,
  };
};
