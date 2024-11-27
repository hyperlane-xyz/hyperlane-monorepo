import { ethers } from 'ethers';

import {
  ChainMap,
  IsmConfig,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
    abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  ): Promise<ChainMap<TokenRouterConfig>> => {
    const ISM_CONFIG: IsmConfig = ethers.constants.AddressZero;

    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      ...abacusWorksEnvOwnerConfig.arbitrum,
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      ...abacusWorksEnvOwnerConfig.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      ...abacusWorksEnvOwnerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      ...abacusWorksEnvOwnerConfig.mode,
      type: TokenType.collateral,
      token: tokens.mode.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      ...abacusWorksEnvOwnerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      ...abacusWorksEnvOwnerConfig.scroll,
      type: TokenType.collateral,
      token: tokens.scroll.USDT,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      ...abacusWorksEnvOwnerConfig.zeronetwork,
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
