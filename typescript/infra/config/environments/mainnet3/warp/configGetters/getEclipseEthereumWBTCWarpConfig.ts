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
import { awSafes } from '../../governance/safe/aw.js';
import { regularSafes } from '../../governance/safe/regular.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

export const getEclipseEthereumWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    owner: awSafes.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'A7EGCDYFw5R7Jfm6cYtKvY8dmkrYMgwRCJFkyQwpHTYu',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.WBTC,
    interchainSecurityModule: ethers.constants.AddressZero,
    proxyAdmin: {
      owner: regularSafes.ethereum,
    },
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
