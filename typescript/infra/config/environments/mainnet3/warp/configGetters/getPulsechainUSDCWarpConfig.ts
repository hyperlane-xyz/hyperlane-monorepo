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
};

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  base: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  polygon: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  ethereum: '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2',
  pulsechain: '0x703cf58975B14142eD0Ba272555789610c85520c',
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
  };

  return deployConfig;
};
