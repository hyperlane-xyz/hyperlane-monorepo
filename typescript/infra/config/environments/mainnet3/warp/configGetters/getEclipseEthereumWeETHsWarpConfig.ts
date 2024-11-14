import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';
import { safes } from '../../owners.js';

// Safe owned by Veda
const ethereumOwner = '0xCEA8039076E35a825854c5C2f85659430b06ec96';
// Vault owned by Veda
const eclipseOwner = '4Cj1s2ipALjJk9foQV4oDaZYCZwSsVkAShQL1KFVJG9b';

export const getEclipseEthereumWeEthsWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: '7Zx4wU1QAw98MfvnPFqRh1oyumek7G5VAX6TKB3U1tcn',
    gas: 300_000,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: eclipseOwner,
  };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.weETHs,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: ethereumOwner,
    ownerOverrides: {
      proxyAdmin: ethereumOwner,
      _safeAddress: safes['ethereum'],
    },
    proxyAdmin: {
      address: '0x2ffc8e94eddda8356f6b66aa035b42b20cf24a08',
      owner: ethereumOwner,
    },
  };

  console.log('ethereum?', ethereum);

  return {
    eclipsemainnet,
    ethereum,
  };
};
