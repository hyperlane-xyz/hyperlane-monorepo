import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const proxyAdmins: ChainMap<Address> = {
  appchain: '0xa8ab7DF354DD5d4bCE5856b2b4E0863A3AaeEb44',
  base: '0xeed4140d3a44fE81712eDFE04c3597cd217d2E61',
};

export const getAppChainBaseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero; // Use the default ISM

  const appchain: HypTokenRouterConfig = {
    mailbox: routerConfig.appchain.mailbox,
    ...abacusWorksEnvOwnerConfig.appchain,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.appchain,
      address: proxyAdmins.appchain,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    mailbox: routerConfig.base.mailbox,
    ...abacusWorksEnvOwnerConfig.base,
    proxyAdmin: {
      ...abacusWorksEnvOwnerConfig.base,
      address: proxyAdmins.base,
    },
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    appchain,
    base,
  };
};
