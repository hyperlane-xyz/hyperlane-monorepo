import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  ethereum: '0xb10B260fBf5F33CC5Ff81761e090aeCDffcb1fd5',
  base: '0xC92aB408512defCf1938858E726dc5C0ada9175a',
  lumiaprism: '0x1b06089dA471355F8F05C7A6d8DE1D9dAC397629',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getBaseEthereumLumiaprismETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const base: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.base,
    owner: safeOwners.base,
    type: TokenType.native,
    interchainSecurityModule: ISM_CONFIG,
  };

  const ethereum: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.ethereum,
    owner: safeOwners.ethereum,
    type: TokenType.native,
    interchainSecurityModule: ISM_CONFIG,
  };

  const lumiaprism: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.lumiaprism,
    owner: safeOwners.lumiaprism,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
    symbol: 'WETH',
  };

  return {
    base,
    ethereum,
    lumiaprism,
  };
};
