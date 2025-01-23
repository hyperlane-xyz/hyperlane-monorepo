import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const formSafes: ChainMap<Address> = {
  base: '0xFCdf33C6461fE8476AA0b7aC92D631d58c4e0d84',
  form: '0x41B624412B529409A437f08Ef80bCabE81053650',
};

export const getBaseFormGAMEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: formSafes.base,
    type: TokenType.collateral,
    token: tokens.base.GAME,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const form: HypTokenRouterConfig = {
    ...routerConfig.form,
    owner: formSafes.form,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    form,
    base,
  };
};
