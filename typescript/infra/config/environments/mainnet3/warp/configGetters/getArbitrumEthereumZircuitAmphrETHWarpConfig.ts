import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

const arbitrumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const ethereumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const zircuitOwner = '0xD0673e7F3FB4037CA79F53d2d311D0e017d39963';

export const getArbitrumEthereumZircuitAmphrETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: arbitrumOwner,
    ownerOverrides: {
      proxyAdmin: arbitrumOwner,
    },
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.amphrETH,
    owner: ethereumOwner,
    interchainSecurityModule: ethers.constants.AddressZero,
    ownerOverrides: {
      proxyAdmin: ethereumOwner,
    },
  };

  const zircuit: TokenRouterConfig = {
    ...routerConfig.zircuit,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: zircuitOwner,
    ownerOverrides: {
      proxyAdmin: zircuitOwner,
    },
  };

  return {
    arbitrum,
    ethereum,
    zircuit,
  };
};
