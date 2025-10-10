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
  polygon: T;
  pulsechain: T;
  ethereum: T;
  avalanche: T;
  optimism: T;
  unichain: T;
};

// SAFE wallets from the team

const SAFE_OWNER = '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2';

const ownersByChain: DeploymentChains<Address> = {
  arbitrum: SAFE_OWNER,
  base: SAFE_OWNER,
  polygon: SAFE_OWNER,
  ethereum: SAFE_OWNER,
  // It is still a safe but a different address
  pulsechain: '0x703cf58975B14142eD0Ba272555789610c85520c',
  avalanche: SAFE_OWNER,
  optimism: SAFE_OWNER,
  unichain: SAFE_OWNER,
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
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
