import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Safes from the FORM team
const safeOwners: ChainMap<Address> = {
  ethereum: '0xec5ad23e29203301B2C1a765718Cc1de7A8d3FbF',
  form: '0x41B624412B529409A437f08Ef80bCabE81053650',
};

export const getEthereumFormUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(safeOwners.ethereum),
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const form: HypTokenRouterConfig = {
    ...routerConfig.form,
    ...getOwnerConfigForAddress(safeOwners.form),
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    form,
  };
};
