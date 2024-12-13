import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getBlastZeroNetworkUSDBWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const blast: TokenRouterConfig = {
    ...routerConfig.blast,
    ...abacusWorksEnvOwnerConfig.blast,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.blast,
      address: '0x5FC9b323013DAcF2d56046F9ff0f61c95c6A466B',
    },
    type: TokenType.collateral,
    token: tokens.blast.usdb,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.zeronetwork,
      address: '0x1bE9A7450500287a553C9631bF82d3F8cEb121b3',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  return {
    blast,
    zeronetwork,
  };
};
