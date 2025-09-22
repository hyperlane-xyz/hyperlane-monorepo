import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import {
  getRebalanceableCollateralTokenConfigForChain,
  getSyntheticTokenConfigForChain,
} from './getPulsechainUSDCWarpConfig.js';

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
  electroneum: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  ethereum: '0xe0eb6194A56cdb6a51BB5855cddEbd61c03a199d',
};

export const getElectroneumUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const deployConfig: DeploymentChains<HypTokenRouterConfig> = {
    avalanche: getRebalanceableCollateralTokenConfigForChain(
      'avalanche',
      routerConfig,
      ownersByChain,
    ),
    base: getRebalanceableCollateralTokenConfigForChain(
      'base',
      routerConfig,
      ownersByChain,
    ),
    ethereum: getRebalanceableCollateralTokenConfigForChain(
      'ethereum',
      routerConfig,
      ownersByChain,
    ),

    electroneum: getSyntheticTokenConfigForChain(
      'electroneum',
      routerConfig,
      ownersByChain,
    ),
  };

  return deployConfig;
};
