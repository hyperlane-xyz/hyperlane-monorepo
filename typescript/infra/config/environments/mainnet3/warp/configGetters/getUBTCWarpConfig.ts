import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const getUBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const bsquared: HypTokenRouterConfig = {
    ...routerConfig.bsquared,
    owner: '0x7A363efD42305BeDBA307d25351F8ea157b69A1A',
    type: TokenType.collateral,
    token: '0x796e4D53067FF374B89b2Ac101ce0c1f72ccaAc2',
  };

  const swell: HypTokenRouterConfig = {
    ...routerConfig.swell,
    owner: '0xC11e22A31787394950B31e2DEb1d2b5546689B65',
    type: TokenType.synthetic,
  };

  return {
    bsquared,
    swell,
  };
};
