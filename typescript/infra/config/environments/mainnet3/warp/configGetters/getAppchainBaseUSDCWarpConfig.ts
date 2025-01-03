import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  IsmConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  appchain: '0xe3436b3335fa6d4f1b58153079FB360c6Aa83Fd9',
  base: '0xE3b50a565fbcdb6CC67B30bEB112f9e7FC855359',
};

export const getAppChainBaseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero; // Use the default ISM

  const appchain: HypTokenRouterConfig = {
    mailbox: routerConfig.appchain.mailbox,
    owner: safeOwners.appchain,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    mailbox: routerConfig.base.mailbox,
    owner: safeOwners.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    appchain,
    base,
  };
};
