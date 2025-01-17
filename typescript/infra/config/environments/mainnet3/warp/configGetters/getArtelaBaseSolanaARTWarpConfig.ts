import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Artela MPC wallt
const EVM_OWNER = '0x801e8135867D65e742eb070A9fC0aD9c2f69B4cd';
// Artela Squad vault
const SOLANA_OWNER = 'G4ekReWuTheawZ2DNw5k5iA8pGACt7auKwQeEcGi6GWj';

// Default ISM
const ISM_CONFIG = ethers.constants.AddressZero;

export const getArtelaBaseSolanaARTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const artela: HypTokenRouterConfig = {
    mailbox: routerConfig.artela.mailbox,
    owner: EVM_OWNER,
    type: TokenType.native,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: HypTokenRouterConfig = {
    mailbox: routerConfig.base.mailbox,
    owner: EVM_OWNER,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const solanamainnet: HypTokenRouterConfig = {
    mailbox: routerConfig.solanamainnet.mailbox,
    type: TokenType.synthetic,
    owner: SOLANA_OWNER,
    foreignDeployment: 'ELAJhVNCRfipNT99YTfPBGTAgyD5x9mEv3DYr9fvRM2C',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  return {
    artela,
    base,
    solanamainnet,
  };
};
