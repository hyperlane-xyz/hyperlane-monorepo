import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const Re7Safes = {
  ethereum: '0x184d597Be309e11650ca6c935B483DcC05551578',
  zircuit: '0x7Ac2631B4F87801965Acdad169949D6f865068f7',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumZircuitRe7LRTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: Re7Safes.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.Re7LRT,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zircuit: HypTokenRouterConfig = {
    ...routerConfig.zircuit,
    owner: Re7Safes.zircuit,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    zircuit,
  };
};
