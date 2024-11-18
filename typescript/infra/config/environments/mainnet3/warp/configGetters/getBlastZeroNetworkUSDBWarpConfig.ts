import { ethers } from 'ethers';

import {
  ChainMap,
  IsmType,
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
    interchainSecurityModule: {
      owner: ethers.constants.AddressZero,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: {
      owner: ethers.constants.AddressZero,
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
  };
  return {
    blast,
    zeronetwork,
  };
};
