import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { safes } from '../../owners.js';

const USDB_ADDRESS = '0x4300000000000000000000000000000000000003';

export const getBlastZeroNetworkUSDBWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const blast: TokenRouterConfig = {
    ...routerConfig.blast,
    type: TokenType.collateral,
    token: USDB_ADDRESS,
    interchainSecurityModule: {
      owner: '0x723e7694dc346e5a15fB6F6A0144479aC624C66F',
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.blast,
  };

  const zeronetwork: TokenRouterConfig = {
    ...routerConfig.zeronetwork,
    type: TokenType.synthetic,
    interchainSecurityModule: {
      owner: '0x723e7694dc346e5a15fB6F6A0144479aC624C66F',
      type: IsmType.FALLBACK_ROUTING,
      domains: {},
    },
    owner: safes.zeronetwork,
  };
  return {
    blast,
    zeronetwork,
  };
};
