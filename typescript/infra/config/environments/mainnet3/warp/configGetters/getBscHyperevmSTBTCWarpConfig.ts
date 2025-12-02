import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  bsc: '0x2313057ba402C55dAE1a1E8086B37fc6Ef7B3503',
  hyperevm: '0x5A2ee9A4B4D6076cDb3a08c9ae5aca1bD8AD3b02',
};

export const getBscHyperevmSTBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: safeOwners.bsc,
    type: TokenType.collateral,
    token: tokens.bsc.stBTC,
  };

  const hyperevm: HypTokenRouterConfig = {
    ...routerConfig.hyperevm,
    owner: safeOwners.hyperevm,
    type: TokenType.synthetic,
  };

  return {
    bsc,
    hyperevm,
  };
};
