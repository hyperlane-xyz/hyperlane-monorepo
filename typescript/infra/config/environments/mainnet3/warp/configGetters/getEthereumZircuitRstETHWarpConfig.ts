import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const RstETHSafes = {
  ethereum: '0xDA0d054265bB30F4f32C92066428FE57513E7ee1',
  zircuit: '0xA1895dF8AE7b7678E82E76b167A24c82Fb83ec9A',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumZircuitRstETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: RstETHSafes.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.rstETH,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zircuit: HypTokenRouterConfig = {
    ...routerConfig.zircuit,
    owner: RstETHSafes.zircuit,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    zircuit,
  };
};
