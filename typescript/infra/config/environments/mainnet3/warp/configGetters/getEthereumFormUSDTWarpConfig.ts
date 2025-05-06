import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

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
    owner: safeOwners.ethereum,
    proxyAdmin: {
      owner: safeOwners.ethereum,
    },
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const form: HypTokenRouterConfig = {
    ...routerConfig.form,
    owner: safeOwners.form,
    proxyAdmin: {
      owner: safeOwners.form,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    form,
  };
};
