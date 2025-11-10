import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import {
  getRebalancingUSDCConfigForChain,
  getSyntheticTokenConfigForChain,
  getUSDCRebalancingBridgesConfigFor,
} from './utils.js';

type DeploymentChains<T> = {
  arbitrum: T;
  base: T;
  ethereum: T;
  incentiv: T;
  optimism: T;
  polygon: T;
};

const SAFE_OWNER_ADDRESS = '0x64F6C20eAeaF8418F73E1D399d8b86B9eA26e6F2';
const INCENTIV_OWNER_ADDRESS = '0x4c1B3430ec07F2D58b07a18c53B6f92603C2eF3F';

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: SAFE_OWNER_ADDRESS,
  base: SAFE_OWNER_ADDRESS,
  ethereum: SAFE_OWNER_ADDRESS,
  incentiv: INCENTIV_OWNER_ADDRESS,
  optimism: SAFE_OWNER_ADDRESS,
  polygon: SAFE_OWNER_ADDRESS,
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
);

export const getIncentivUSDCWarpConfig = async (
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
    incentiv: getSyntheticTokenConfigForChain(
      'incentiv',
      routerConfig,
      ownersByChain,
    ),
    optimism: getRebalancingUSDCConfigForChain(
      'optimism',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    polygon: getRebalancingUSDCConfigForChain(
      'polygon',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
  };

  return deployConfig;
};
