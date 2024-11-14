import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Safe owned by Veda
const ethereumOwner = '0xCEA8039076E35a825854c5C2f85659430b06ec96';
// Vault owned by Veda
const eclipseOwner = '4Cj1s2ipALjJk9foQV4oDaZYCZwSsVkAShQL1KFVJG9b';

export async function getEclipseEthereumWeEthsWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...getOwnerConfigForAddress(eclipseOwner),
    type: TokenType.synthetic,
    foreignDeployment: '7Zx4wU1QAw98MfvnPFqRh1oyumek7G5VAX6TKB3U1tcn',
    gas: 300_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(ethereumOwner),
    type: TokenType.collateral,
    token: tokens.ethereum.weETHs,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
}
