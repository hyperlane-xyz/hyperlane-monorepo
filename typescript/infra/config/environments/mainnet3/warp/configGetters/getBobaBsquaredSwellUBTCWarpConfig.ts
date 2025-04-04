import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const safeOwners: ChainMap<Address> = {
  bsquared: '0x7A363efD42305BeDBA307d25351F8ea157b69A1A',
  swell: '0xC11e22A31787394950B31e2DEb1d2b5546689B65',
  boba: '0x207FfFa7325fC5d0362aB01605D84B268b61888f',
  soneium: '0x8433e6e9183B5AAdaf4b52c624B963D95956e3C9',
};

export const getBobaBsquaredSoneiumSwellUBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const boba: HypTokenRouterConfigMailboxOptional = {
    owner: safeOwners.boba,
    type: TokenType.synthetic,
  };

  const bsquared: HypTokenRouterConfigMailboxOptional = {
    owner: safeOwners.bsquared,
    type: TokenType.collateral,
    token: tokens.bsquared.uBTC,
  };

  const soneium: HypTokenRouterConfigMailboxOptional = {
    owner: safeOwners.soneium,
    type: TokenType.synthetic,
  };

  const swell: HypTokenRouterConfigMailboxOptional = {
    owner: safeOwners.swell,
    type: TokenType.synthetic,
  };

  return {
    boba,
    bsquared,
    soneium,
    swell,
  };
};
