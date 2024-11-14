import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getArbitrumBscEthereumMantleModePolygonScrollZeroNetworkUSDT =
  async (
    routerConfig: ChainMap<RouterConfig>,
  ): Promise<ChainMap<TokenRouterConfig>> => {
    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const bsc: TokenRouterConfig = {
      ...routerConfig.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      type: TokenType.collateral,
      token: tokens.mode.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      type: TokenType.collateral,
      token: tokens.scroll.USDT,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      type: TokenType.synthetic,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    return {
      arbitrum,
      bsc,
      ethereum,
      mantle,
      mode,
      polygon,
      scroll,
      zeronetwork,
    };
  };
