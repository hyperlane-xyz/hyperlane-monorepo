import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getEthereumVictionETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const viction: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.viction,
    ...abacusWorksEnvOwnerConfig.viction,
    type: TokenType.synthetic,
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
    gas: 50_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.native,
    gas: 65_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    viction,
    ethereum,
  };
};
