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

// Team SAFE on ethereum; other chains use ICAs controlled by it
const ownersByChain: DeploymentChains<Address> = {
  arbitrum: '0xF9F53ba338e6460Ef48AC58d669d64422De9cad9',
  base: '0xa8c402544A136E0a3864A9316877Bc65F31f75d2',
  ethereum: SAFE_OWNER_ADDRESS,
  mantra: '0x6Ccf8A07682d5C317B44f654F8FacC5be8b1d930',
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [
    WarpRouteIds.MainnetCCTPV1,
    WarpRouteIds.MainnetCCTPV2Standard,
    WarpRouteIds.MainnetCCTPV2Fast,
  ],
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
