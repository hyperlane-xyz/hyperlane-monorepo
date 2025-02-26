import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// These addresses are currently EOAs the
// team said they will transfer ownership to safes later
const ownersByChain: ChainMap<Address> = {
  solanamainnet: '9ucjS236rPP1LheTYytdoAZ9B2DDFQDdL6tGdigeFqn8',
  mint: '0x9AabD861DFA0dcEf61b55864A03eF257F1c6093A',
};

export const getMintSolanaMintWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    solanamainnet: {
      ...routerConfig.solanamainnet,
      owner: ownersByChain.solanamainnet,
      type: TokenType.synthetic,
      foreignDeployment: 'J766C8JY4xE6S6fbyJMKDZq6RbvHWrrvB2HQx29KWJUD',
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
    mint: {
      ...routerConfig.mint,
      type: TokenType.collateral,
      owner: ownersByChain.mint,
      interchainSecurityModule: ethers.constants.AddressZero,
      token: tokens.mint.MINT,
    },
  };
};
