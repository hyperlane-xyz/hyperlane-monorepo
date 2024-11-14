import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getEclipseEthereumWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'A7EGCDYFw5R7Jfm6cYtKvY8dmkrYMgwRCJFkyQwpHTYu',
    gas: 300_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
