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
  avalanche: T;
  base: T;
  electroneum: T;
  ethereum: T;
};

// Electroneum team Safe on ethereum and its ICAs
const ownersByChain: DeploymentChains<Address> = {
  avalanche: '0x0F4af3261c40445ff4618bd01AeCA11410Ef6025', // ICA - origin chain is ethereum
  base: '0xe525F3C7409211160f6F06Ca58A2d23d5265d3C3', // ICA - origin chain is ethereum
  electroneum: '0x75BC257549A48Ee12624645Ad4a5E847A2537E66', // ICA - origin chain is ethereum
  ethereum: '0xe0eb6194A56cdb6a51BB5855cddEbd61c03a199d',
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [
    WarpRouteIds.MainnetCCTPV1,
    WarpRouteIds.MainnetCCTPV2Standard,
    WarpRouteIds.MainnetCCTPV2Fast,
  ],
);

export const getElectroneumUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig: DeploymentChains<HypTokenRouterConfig> = {
    avalanche: getRebalancingUSDCConfigForChain(
      'avalanche',
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

    electroneum: getSyntheticTokenConfigForChain(
      'electroneum',
      routerConfig,
      ownersByChain,
    ),
  };

  return deployConfig;
};
