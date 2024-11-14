import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    type: TokenType.collateral,
    token: tokens.arbitrum.USDC,
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  const base: TokenRouterConfig = {
    ...routerConfig.base,
    type: TokenType.collateral,
    token: tokens.base.USDC,
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  const optimism: TokenRouterConfig = {
    ...routerConfig.optimism,
    type: TokenType.collateral,
    token: tokens.optimism.USDC,
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  const polygon: TokenRouterConfig = {
    ...routerConfig.polygon,
    type: TokenType.collateral,
    token: tokens.polygon.USDC,
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.collateral,
    token: '0x6a6394F47DD0BAF794808F2749C09bd4Ee874E70',
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: {
      type: IsmType.FALLBACK_ROUTING,
      owner: '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913',
      domains: {},
    },
  };

  return {
    arbitrum,
    base,
    ethereum,
    optimism,
    polygon,
    zeronetwork,
  };
};
