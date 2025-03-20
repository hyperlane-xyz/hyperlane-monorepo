import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const owners = {
  ethereum: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
  superseed: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumSuperseedUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: owners.superseed,
    type: TokenType.collateralFiat,
    token: '0xc316c8252b5f2176d0135ebb0999e99296998f2e',
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    superseed,
  };
};
