import { ethers } from 'ethers';

import {
  ChainMap,
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
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  return {
    polygon,
    zeronetwork,
  };
};
