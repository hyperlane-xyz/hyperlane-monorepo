import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getBaseZeroNetworkCBBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const base: TokenRouterConfig = {
    ...routerConfig.base,
    type: TokenType.collateral,
    token: tokens.base.cbBTC,
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
    base,
    zeronetwork,
  };
};
