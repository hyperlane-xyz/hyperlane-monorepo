import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfig>,
  ): Promise<ChainMap<TokenRouterConfig>> => {
    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const base: TokenRouterConfig = {
      ...routerConfig.base,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const blast: TokenRouterConfig = {
      ...routerConfig.blast,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const bsc: TokenRouterConfig = {
      ...routerConfig.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const gnosis: TokenRouterConfig = {
      ...routerConfig.gnosis,
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const optimism: TokenRouterConfig = {
      ...routerConfig.optimism,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const zoramainnet: TokenRouterConfig = {
      ...routerConfig.zoramainnet,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      type: TokenType.native,
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
        domains: {},
      },
    };

    return {
      arbitrum,
      base,
      blast,
      bsc,
      gnosis,
      mantle,
      mode,
      optimism,
      polygon,
      scroll,
      zeronetwork,
      zoramainnet,
      ethereum,
    };
  };
