import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Elixir
const owner = '0x00000000F51340906F767C6999Fe512b1275955C';
const elixirSafe = '0x738744237b7fd97af670d9ddf54390c24263cea8';
const ownerConfig = getOwnerConfigForAddress(owner);

export const getEthereumSeiFastUSDWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const sei: HypTokenRouterConfig = {
    ...routerConfig.viction,
    ...ownerConfig,
    type: TokenType.XERC20,
    name: 'fastUSD',
    symbol: 'fastUSD',
    decimals: 18,
    token: tokens.sei.fastUSD,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: elixirSafe,
    ownerOverrides: {
      proxyAdmin: owner,
    },
    type: TokenType.collateral,
    token: tokens.ethereum.deUSD,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    sei,
    ethereum,
  };
};
