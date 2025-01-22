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
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Cod3x SAFE
const baseOwner = '0xfEfcb2fb19b9A70B30646Fdc1A0860Eb12F7ff8b';
// Cod3x Squads vault
const solanamainnetOwner = '7dRAVvdmV3dy4JieuRAirBQ9oSpYaHgmYwupoK5YZcFR';

export async function getBaseSolanamainnetTONYWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  let base: HypTokenRouterConfig = {
    mailbox: routerConfig.base.mailbox,
    owner: baseOwner,
    type: TokenType.collateral,
    token: tokens.base.TONY,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const solanamainnet: HypTokenRouterConfig = {
    mailbox: routerConfig.solanamainnet.mailbox,
    owner: solanamainnetOwner,
    type: TokenType.synthetic,
    foreignDeployment: 'Fa4zQJCH7id5KL1eFJt2mHyFpUNfCCSkHgtMrLvrRJBN',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    base,
    solanamainnet,
  };
}
