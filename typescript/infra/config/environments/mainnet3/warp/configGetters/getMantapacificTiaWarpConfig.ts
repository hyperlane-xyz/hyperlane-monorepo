import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getMantapacificTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const celestia: HypTokenRouterConfig = {
    ...routerConfig.celestia,
    ...abacusWorksEnvOwnerConfig.celestia,
    type: TokenType.collateral,
    name: 'TIA',
    symbol: 'TIA',
    token: 'utia',
    decimals: 6,
  };

  const mantapacific: HypTokenRouterConfig = {
    ...routerConfig.mantapacific,
    ...abacusWorksEnvOwnerConfig.mantapacific,
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA',
    decimals: 6,
    gas: 600_000,
    remoteRouters: {
      celestia: {
        address:
          '0x726f757465725f61707000000000000000000000000000010000000000000007',
      },
    },
  };

  return {
    mantapacific,
    celestia,
  };
};
