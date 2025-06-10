import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  TokenType,
  TxSubmitterType,
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
  nibiru: '0x2D439F9B80F7f5010A577B25E1Ec9d84C4e69e4E',
};

export const getBsquaredUBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const boba: HypTokenRouterConfig = {
    mailbox: routerConfig.boba.mailbox,
    owner: safeOwners.boba,
    type: TokenType.synthetic,
  };

  const bsquared: HypTokenRouterConfig = {
    mailbox: routerConfig.bsquared.mailbox,
    owner: safeOwners.bsquared,
    type: TokenType.collateral,
    token: tokens.bsquared.uBTC,
  };

  const nibiru: HypTokenRouterConfig = {
    mailbox: routerConfig.nibiru.mailbox,
    owner: safeOwners.nibiru,
    type: TokenType.synthetic,
    name: 'uBTC',
    symbol: 'uBTC',
    decimals: 18,
  };

  const soneium: HypTokenRouterConfig = {
    mailbox: routerConfig.soneium.mailbox,
    owner: safeOwners.soneium,
    type: TokenType.synthetic,
  };

  const swell: HypTokenRouterConfig = {
    mailbox: routerConfig.swell.mailbox,
    owner: safeOwners.swell,
    type: TokenType.synthetic,
  };

  return {
    boba,
    bsquared,
    nibiru,
    soneium,
    swell,
  };
};

export function getUbtcOwnerConfigGenerator(safes: Record<string, string>) {
  return (): ChainSubmissionStrategy => {
    return Object.fromEntries(
      Object.entries(safes).map(([chain, safeAddress]) => [
        chain,
        {
          submitter:
            chain === 'nibiru'
              ? {
                  type: TxSubmitterType.JSON_RPC,
                  version: '1.0',
                  chain,
                }
              : {
                  type: TxSubmitterType.GNOSIS_SAFE,
                  version: '1.0',
                  chain,
                  safeAddress,
                },
        },
      ]),
    );
  };
}

export const getUbtcGnosisSafeBuilderStrategyConfigGenerator =
  getUbtcOwnerConfigGenerator(safeOwners);
