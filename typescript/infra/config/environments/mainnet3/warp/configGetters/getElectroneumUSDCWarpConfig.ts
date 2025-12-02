import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

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

// SAFE wallets from the team
const ownersByChain: DeploymentChains<Address> = {
  avalanche: '0xe0eb6194A56cdb6a51BB5855cddEbd61c03a199d',
  base: '0xe0eb6194A56cdb6a51BB5855cddEbd61c03a199d',
  electroneum: '0x75BC257549A48Ee12624645Ad4a5E847A2537E66', // ICA - origin chain is ethereum
  ethereum: '0xe0eb6194A56cdb6a51BB5855cddEbd61c03a199d',
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
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
