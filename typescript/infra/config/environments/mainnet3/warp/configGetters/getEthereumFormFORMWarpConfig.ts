import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const formSafes = {
  ethereum: '0xec5ad23e29203301B2C1a765718Cc1de7A8d3FbF',
  form: '0x41B624412B529409A437f08Ef80bCabE81053650',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumFormFORMWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: formSafes.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.FORM,
    interchainSecurityModule: ISM_CONFIG,
  };

  const form: HypTokenRouterConfig = {
    ...routerConfig.form,
    owner: formSafes.form,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    form,
  };
};
