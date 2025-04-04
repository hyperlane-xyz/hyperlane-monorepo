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

export const getEclipseEthereumWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'A7EGCDYFw5R7Jfm6cYtKvY8dmkrYMgwRCJFkyQwpHTYu',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
