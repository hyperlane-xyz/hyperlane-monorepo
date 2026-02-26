import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';

import {
  getRebalancingUSDCConfigForChain,
  getSyntheticTokenConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

type DeploymentChains<T> = {
  arbitrum: T;
  base: T;
  ethereum: T;
  mantra: T;
};

const SAFE_OWNER_ADDRESS = '0x66B6FF38b988759E57509f00c7B9717b1a94DA4D';

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: SAFE_OWNER_ADDRESS,
  base: SAFE_OWNER_ADDRESS,
  ethereum: SAFE_OWNER_ADDRESS,
  mantra: SAFE_OWNER_ADDRESS,
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [WarpRouteIds.MainnetCCTPV1],
);

export const getMantraUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig: DeploymentChains<HypTokenRouterConfig> = {
    arbitrum: getRebalancingUSDCConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    base: getRebalancingUSDCConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    ethereum: getRebalancingUSDCConfigForChain(
      'ethereum',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    mantra: getSyntheticTokenConfigForChain(
      'mantra',
      routerConfig,
      ownersByChain,
    ),
  };

  return deployConfig;
};
