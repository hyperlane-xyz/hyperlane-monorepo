import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getEthereumInevmUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    hook: '0xb87AC8EA4533AE017604E44470F7c1E550AC6F10', // aggregation of IGP and Merkle, arbitrary config not supported for now, TODO: may want to move to zero address in future
  };

  const inevm: HypTokenRouterConfig = {
    ...routerConfig.inevm,
    ...abacusWorksEnvOwnerConfig.inevm,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    inevm,
  };
};
