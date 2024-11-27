import { ethers } from 'ethers';

import {
  ChainMap,
  IsmConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfig>,
  ): Promise<ChainMap<TokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      type: TokenType.collateral,
      token: tokens.mode.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      type: TokenType.collateral,
      token: tokens.scroll.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      type: TokenType.synthetic,
      interchainSecurityModule: ISM_CONFIG,
    };

    return {
      arbitrum,
      ethereum,
      mantle,
      mode,
      polygon,
      scroll,
      zeronetwork,
    };
  };
