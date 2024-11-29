import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getBscZeroNetworkBNBWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const bsc: TokenRouterConfig = {
    ...routerConfig.bsc,
    ...abacusWorksEnvOwnerConfig.bsc,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.bsc,
      address: '0xAdF4F5b38Bb2d18afB138C982C6962CFe6529b1F',
    },
    type: TokenType.native,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0x90D839Bd9b1BbA823ba555Ae0c551D3cE55b0442',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  return {
    bsc,
    zeronetwork,
  };
};
