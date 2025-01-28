import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getEthereumVictionETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const viction: HypTokenRouterConfig = {
    ...routerConfig.viction,
    ...getOwnerConfigForAddress(abacusWorksEnvOwnerConfig.viction.owner),
    type: TokenType.synthetic,
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
    totalSupply: 0,
    gas: 50_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...getOwnerConfigForAddress(abacusWorksEnvOwnerConfig.ethereum.owner),
    type: TokenType.native,
    gas: 65_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    viction,
    ethereum,
  };
};
