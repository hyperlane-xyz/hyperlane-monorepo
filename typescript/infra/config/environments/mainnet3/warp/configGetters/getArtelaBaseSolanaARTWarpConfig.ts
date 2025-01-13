import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  RouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const SOLANA_ART_ADDRESS = 'BLABLA';
export const getArtelaBaseSolanaARTWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const artela: HypTokenRouterConfig = {
    ...routerConfig.artela,
    type: TokenType.native,
    foreignDeployment: SOLANA_ART_ADDRESS,
    interchainSecurityModule: ethers.constants.AddressZero,
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    type: TokenType.synthetic,
    foreignDeployment: SOLANA_ART_ADDRESS,
    interchainSecurityModule: ethers.constants.AddressZero,
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  return {
    artela,
    base,
  };
};
