import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import {
  getCollateralTokenConfigForChain,
  getNativeTokenConfigForChain,
  getSyntheticTokenConfigForChain,
} from './utils.js';

type DeploymentChains<T> = {
  litchain: T;
  arbitrum: T;
  base: T;
  optimism: T;
  ethereum: T;
  avalanche: T;
  polygon: T;
  bsc: T;
  linea: T;
};

const collateralsByChain: Pick<
  DeploymentChains<Address>,
  'arbitrum' | 'base' | 'optimism' | 'ethereum'
> = {
  arbitrum: '0xC7603786470F04D33E35f9E9B56bD0Ca8803fB95',
  base: '0xF732A566121Fa6362E9E0FBdd6D66E5c8C925E49',
  ethereum: '0x4D4eb0E8B160f6EbF63cC6d36060ffec09301B42',
  optimism: '0x0633E91f64C22d4FEa53dbE6e77B7BA4093177B8',
};

// SAFE wallet from the team
const DEFAULT_SAFE_OWNER = '0x4a49b859C481a300aC7C732F7d64edd61392DC8E';

const ownersByChain: DeploymentChains<Address> = {
  arbitrum: DEFAULT_SAFE_OWNER,
  base: DEFAULT_SAFE_OWNER,
  polygon: DEFAULT_SAFE_OWNER,
  ethereum: DEFAULT_SAFE_OWNER,
  // It is still a safe but a different address
  litchain: '0xC6EBB3ca53D028F419F677Ed45126490331F728b',
  avalanche: DEFAULT_SAFE_OWNER,
  optimism: DEFAULT_SAFE_OWNER,
  linea: DEFAULT_SAFE_OWNER,
  bsc: DEFAULT_SAFE_OWNER,
};

export const getLitchainLITKEYWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig: DeploymentChains<HypTokenRouterConfig> = {
    // Collateral chains
    arbitrum: getCollateralTokenConfigForChain(
      'arbitrum',
      routerConfig,
      ownersByChain,
      collateralsByChain,
    ),
    base: getCollateralTokenConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
      collateralsByChain,
    ),
    ethereum: getCollateralTokenConfigForChain(
      'ethereum',
      routerConfig,
      ownersByChain,
      collateralsByChain,
    ),
    optimism: getCollateralTokenConfigForChain(
      'optimism',
      routerConfig,
      ownersByChain,
      collateralsByChain,
    ),
    // Native
    litchain: getNativeTokenConfigForChain(
      'litchain',
      routerConfig,
      ownersByChain,
    ),
    // Synthetic chains
    avalanche: getSyntheticTokenConfigForChain(
      'avalanche',
      routerConfig,
      ownersByChain,
    ),
    bsc: getSyntheticTokenConfigForChain('bsc', routerConfig, ownersByChain),
    polygon: getSyntheticTokenConfigForChain(
      'polygon',
      routerConfig,
      ownersByChain,
    ),
    linea: getSyntheticTokenConfigForChain(
      'linea',
      routerConfig,
      ownersByChain,
    ),
  };

  return deployConfig;
};
