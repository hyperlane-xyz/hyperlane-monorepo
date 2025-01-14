import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const ARTELA_OWNER = '0x801e8135867D65e742eb070A9fC0aD9c2f69B4cd';
const ART_ON_SOLANA_ADDRESS = 'ELAJhVNCRfipNT99YTfPBGTAgyD5x9mEv3DYr9fvRM2C';
const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM
export const getArtelaBaseSolanaARTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const artela: HypTokenRouterConfig = {
    ...routerConfig.artela,
    type: TokenType.native,
    owner: ARTELA_OWNER,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    ...routerConfig.base,
    type: TokenType.synthetic,
    owner: ARTELA_OWNER,
    interchainSecurityModule: ISM_CONFIG,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    type: TokenType.synthetic,
    owner: abacusWorksEnvOwnerConfig.solanamainnet.owner,
    foreignDeployment: ART_ON_SOLANA_ADDRESS,
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  return {
    artela,
    base,
    solanamainnet,
  };
};
