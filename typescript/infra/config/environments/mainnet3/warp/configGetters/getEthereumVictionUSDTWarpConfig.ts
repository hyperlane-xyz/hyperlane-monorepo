import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getEthereumVictionUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const viction: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.viction,
    ...abacusWorksEnvOwnerConfig.viction,
    type: TokenType.synthetic,
    name: 'USDT',
    symbol: 'USDT',
    decimals: 6,
    gas: 75_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    gas: 65_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    viction,
    ethereum,
  };
};
