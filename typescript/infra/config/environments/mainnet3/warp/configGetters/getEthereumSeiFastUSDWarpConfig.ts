import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  getNonAbacusWorksOwnerConfig,
  tokens,
} from '../../../../../src/config/warp.js';

// Elixir
const owner = '0x00000000F51340906F767C6999Fe512b1275955C';
const ownerConfig = getNonAbacusWorksOwnerConfig(owner);

export const getEthereumSeiFastUSDWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const sei: TokenRouterConfig = {
    ...routerConfig.viction,
    ...ownerConfig,
    type: TokenType.XERC20,
    name: 'fastUSD',
    symbol: 'fastUSD',
    decimals: 18,
    token: tokens.sei.fastUSD,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...ownerConfig,
    type: TokenType.collateral,
    token: tokens.ethereum.deUSD,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    sei,
    ethereum,
  };
};
