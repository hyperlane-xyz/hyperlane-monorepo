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
  polygon: T;
  pulsechain: T;
  ethereum: T;
  avalanche: T;
  optimism: T;
  unichain: T;
};

// SAFE wallets from the team

const DEFAULT_SAFE_OWNER = '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2';

const ownersByChain: DeploymentChains<Address> = {
  arbitrum: DEFAULT_SAFE_OWNER,
  base: DEFAULT_SAFE_OWNER,
  polygon: DEFAULT_SAFE_OWNER,
  ethereum: DEFAULT_SAFE_OWNER,
  // It is still a safe but a different address
  pulsechain: '0x703cf58975B14142eD0Ba272555789610c85520c',
  avalanche: DEFAULT_SAFE_OWNER,
  optimism: DEFAULT_SAFE_OWNER,
  unichain: DEFAULT_SAFE_OWNER,
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [WarpRouteIds.MainnetCCTPV1],
);

export const getPulsechainUSDCWarpConfig = async (
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
    polygon: getRebalancingUSDCConfigForChain(
      'polygon',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    pulsechain: getSyntheticTokenConfigForChain(
      'pulsechain',
      routerConfig,
      ownersByChain,
    ),
    avalanche: getRebalancingUSDCConfigForChain(
      'avalanche',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    optimism: getRebalancingUSDCConfigForChain(
      'optimism',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
    unichain: getRebalancingUSDCConfigForChain(
      'unichain',
      routerConfig,
      ownersByChain,
      rebalancingConfigByChain,
    ),
  };

  return deployConfig;
};
