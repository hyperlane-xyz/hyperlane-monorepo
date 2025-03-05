import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const artelaOwner = '0x801e8135867D65e742eb070A9fC0aD9c2f69B4cd';
const baseOwner = '0x801e8135867D65e742eb070A9fC0aD9c2f69B4cd';

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getArtelaBaseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const artela: HypTokenRouterConfig = {
    ...routerConfig.artela,
    owner: artelaOwner,
    type: TokenType.synthetic,
    symbol: 'USDC.a',
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    owner: baseOwner,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    artela,
    base,
  };
};
