import {
  ChainMap,
  IsmConfig,
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
    const ISM_CONFIG: IsmConfig = {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    };

    const arbitrum: TokenRouterConfig = {
      ...routerConfig.arbitrum,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const base: TokenRouterConfig = {
      ...routerConfig.base,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const blast: TokenRouterConfig = {
      ...routerConfig.blast,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const bsc: TokenRouterConfig = {
      ...routerConfig.bsc,
      type: TokenType.collateral,
      token: tokens.bsc.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const ethereum: TokenRouterConfig = {
      ...routerConfig.ethereum,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const gnosis: TokenRouterConfig = {
      ...routerConfig.gnosis,
      type: TokenType.collateral,
      token: tokens.gnosis.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mantle: TokenRouterConfig = {
      ...routerConfig.mantle,
      type: TokenType.collateral,
      token: tokens.mantle.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const mode: TokenRouterConfig = {
      ...routerConfig.mode,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const optimism: TokenRouterConfig = {
      ...routerConfig.optimism,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const polygon: TokenRouterConfig = {
      ...routerConfig.polygon,
      type: TokenType.collateral,
      token: tokens.polygon.WETH,
      interchainSecurityModule: ISM_CONFIG,
    };

    const scroll: TokenRouterConfig = {
      ...routerConfig.scroll,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zeronetwork: TokenRouterConfig = {
      ...routerConfig.zeronetwork,
      type: TokenType.native,
      interchainSecurityModule: ISM_CONFIG,
    };

    const zoramainnet: TokenRouterConfig = {
      ...routerConfig.zoramainnet,
      type: TokenType.native,
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
      lisk,
    };
  };
