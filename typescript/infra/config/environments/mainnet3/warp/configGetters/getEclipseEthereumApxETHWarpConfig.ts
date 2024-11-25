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

export async function getEclipseEthereumApxEthWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> {
  // const eclipsemainnet: TokenRouterConfig = {
  //   ...routerConfig.eclipsemainnet,
  //   ...getOwnerConfigForAddress(DEPLOYER),
  //   type: TokenType.synthetic,
  //   foreignDeployment: '',
  //   gas: 300_000,
  //   interchainSecurityModule: ethers.constants.AddressZero,
  // };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(DEPLOYER),
    type: TokenType.collateral,
    token: tokens.ethereum.apxETH,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    // eclipsemainnet,
    ethereum,
  };
}
