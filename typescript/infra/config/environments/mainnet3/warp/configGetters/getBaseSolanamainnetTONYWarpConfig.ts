import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Need to transfer ownership later

export async function getBaseSolanamainnetTONYWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  let base: HypTokenRouterConfig = {
    ...routerConfig.base,
    ...getOwnerConfigForAddress(DEPLOYER),
    type: TokenType.collateral,
    token: tokens.base.TONY,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const solanamainnet: HypTokenRouterConfig = {
    ...routerConfig.solanamainnet,
    ...getOwnerConfigForAddress(DEPLOYER),
    type: TokenType.synthetic,
    foreignDeployment: '4AQVPTCAeLswnjksQdutxUDuxEJxUBwoWmVimGuPtGSt',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    base,
    solanamainnet,
  };
}
