import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

export const getEclipseEthereumESWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    eclipsemainnet: {
      ...routerConfig.eclipsemainnet,
      // Deployer Key
      owner: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
      type: TokenType.synthetic,
      foreignDeployment: '2JvSu7PzquY2b8NDZbnupFZ1jezqMBtNUhi7TuU3GQJD',
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    },
    ethereum: {
      ...routerConfig.ethereum,
      type: TokenType.collateral,
      //   Deployer Key
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      interchainSecurityModule: ethers.constants.AddressZero,
      token: tokens.ethereum.ES,
    },
  };
};
