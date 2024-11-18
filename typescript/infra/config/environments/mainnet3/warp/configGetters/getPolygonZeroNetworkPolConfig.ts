import { ethers } from 'ethers';

import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getPolygonZeroNetworkPolWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const polygon: TokenRouterConfig = {
    ...routerConfig.polygon,
    type: TokenType.native,
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
    polygon,
    zeronetwork,
  };
};
