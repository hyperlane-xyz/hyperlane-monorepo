import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getPolygonZeroNetworkPolWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const polygon: TokenRouterConfig = {
    ...routerConfig.polygon,
    ...abacusWorksEnvOwnerConfig.polygon,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.polygon,
      address: '0xb72A8527eb48B0648EA8664a45Bc618D16593Cc5',
    },
    type: TokenType.native,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0x2F701Fb783BB57240B36319966733318858646ed',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  return {
    polygon,
    zeronetwork,
  };
};
