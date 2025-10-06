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
  mantra: T;
};

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
  base: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
  ethereum: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
  mantra: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
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
