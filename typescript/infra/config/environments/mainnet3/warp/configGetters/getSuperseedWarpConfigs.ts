import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  ethereum: '0x11BEBBf509248735203BAAAe90c1a27EEE70D567',
  superseed: '0x6652010BaCE855DF870D427daA6141c313994929',
  optimism: '0x0D493D7E51212bbBF0F1ca4bcfA1E5514C7fEF10',
};

export const getEthereumSuperseedUSDTConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: safeOwners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: safeOwners.superseed,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    superseed,
  };
};

export const getOptimismSuperseedOPConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const optimism: HypTokenRouterConfig = {
    ...routerConfig.optimism,
    owner: safeOwners.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.OP,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const superseed: HypTokenRouterConfig = {
    ...routerConfig.superseed,
    owner: safeOwners.superseed,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    optimism,
    superseed,
  };
};
