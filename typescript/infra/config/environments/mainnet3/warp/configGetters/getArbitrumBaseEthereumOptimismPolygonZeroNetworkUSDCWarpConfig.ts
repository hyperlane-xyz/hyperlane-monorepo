import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ISM_CONFIG = ethers.constants.AddressZero;

  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const base: TokenRouterConfig = {
    ...routerConfig.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const optimism: TokenRouterConfig = {
    ...routerConfig.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const polygon: TokenRouterConfig = {
    ...routerConfig.polygon,
    type: TokenType.collateral,
    token: tokens.polygon.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.collateral,
    token: tokens.zeronetwork.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const lisk: TokenRouterConfig = {
    ...routerConfig.lisk,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    arbitrum,
    base,
    ethereum,
    optimism,
    polygon,
    zeronetwork,
    lisk,
  };
};
