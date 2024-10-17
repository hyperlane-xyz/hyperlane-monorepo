import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

// Elixir
const owner = '0x00000000F51340906F767C6999Fe512b1275955C';

export const getEthereumSeiFastUSDWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const sei: TokenRouterConfig = {
    ...routerConfig.viction,
    type: TokenType.XERC20,
    name: 'fastUSD',
    symbol: 'fastUSD',
    decimals: 18,
    totalSupply: 0,
    token: tokens.sei.fastUSD,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner,
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.deUSD,
    owner,
    interchainSecurityModule: ethers.constants.AddressZero,
    ownerOverrides: {
      proxyAdmin: owner,
    },
  };

  return {
    sei,
    ethereum,
  };
};
