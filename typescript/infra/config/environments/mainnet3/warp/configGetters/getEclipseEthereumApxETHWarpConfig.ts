import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const ethereumOwner = DEPLOYER;
const eclipseOwner = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';

export async function getEclipseEthereumApxEthWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...getOwnerConfigForAddress(eclipseOwner),
    type: TokenType.synthetic,
    foreignDeployment: '9pEgj7m2VkwLtJHPtTw5d8vbB7kfjzcXXCRgdwruW7C2',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    type: TokenType.collateral,
    token: tokens.ethereum.apxETH,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
}
