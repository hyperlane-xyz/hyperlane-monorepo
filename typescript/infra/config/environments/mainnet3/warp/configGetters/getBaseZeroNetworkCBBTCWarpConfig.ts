import { ethers } from 'ethers';

import {
  ChainMap,
  IsmConfig,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getBaseZeroNetworkCBBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

  const base: TokenRouterConfig = {
    ...routerConfig.base,
    ...abacusWorksEnvOwnerConfig.base,
    type: TokenType.collateral,
    token: tokens.base.cbBTC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    ...abacusWorksEnvOwnerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    base,
    zeronetwork,
  };
};
