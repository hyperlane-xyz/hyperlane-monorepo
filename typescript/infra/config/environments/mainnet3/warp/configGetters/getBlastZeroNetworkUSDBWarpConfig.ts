import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getBlastZeroNetworkUSDBWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const blast: TokenRouterConfig = {
    ...routerConfig.blast,
    type: TokenType.collateral,
    token: tokens.blast.usdb,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  return {
    blast,
    zeronetwork,
  };
};
