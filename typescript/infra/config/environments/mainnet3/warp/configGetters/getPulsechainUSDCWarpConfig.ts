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

// Team Safe on ethereum and its ICAs

const DEFAULT_SAFE_OWNER = '0x9adBd244557F59eE8F5633D2d2e2c0abec8FCCC2';

const ownersByChain: DeploymentChains<Address> = {
  arbitrum: '0x04f7B69Fe202eEc282E92659685E27568f32347e', // ICA - origin chain is ethereum
  base: '0x7Eb98E3F4B5a56Ea03A3c2Ee806828DaC680c538', // ICA - origin chain is ethereum
  polygon: '0xE144224F12FF8B7E96483f75fFA8E951395809c0', // ICA - origin chain is ethereum
  ethereum: DEFAULT_SAFE_OWNER,
  pulsechain: '0xD8De3dC2c3dfEa0B7Aea290B295b2A0d0A6C4AC1', // ICA - origin chain is ethereum
  avalanche: '0x1108683f6aE1e91d6426c7961b4cb60a874593B1', // ICA - origin chain is ethereum
  optimism: '0xe0870F79c3d0e02A0b6f6BE48f27f5b234E91B07', // ICA - origin chain is ethereum
  unichain: '0xe9d47fAbC91A58089AF8e2F3f50186CCfa85b816', // ICA - origin chain is ethereum
};

const rebalancingConfigByChain = getUSDCRebalancingBridgesConfigFor(
  Object.keys(ownersByChain),
  [
    WarpRouteIds.MainnetCCTPV1,
    WarpRouteIds.MainnetCCTPV2Standard,
    WarpRouteIds.MainnetCCTPV2Fast,
  ],
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
