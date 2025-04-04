import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
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
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const eclipsemainnet: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'A7EGCDYFw5R7Jfm6cYtKvY8dmkrYMgwRCJFkyQwpHTYu',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfigMailboxOptional = {
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
