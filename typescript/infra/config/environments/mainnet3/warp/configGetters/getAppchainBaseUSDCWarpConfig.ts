import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getAppChainBaseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero; // Use the default ISM

  const appchain: HypTokenRouterConfig = {
    ...routerConfig.appchain,
    ...abacusWorksEnvOwnerConfig.appchain,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...abacusWorksEnvOwnerConfig.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    appchain,
    base,
  };
};
