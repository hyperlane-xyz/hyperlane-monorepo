import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// TODO: Confirm ownership
const safeOwners: ChainMap<Address> = {
  bsc: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
  milkyway: 'milk1326ley07fm6rpeqgxmxevnqevrsjfew2akzupg',
};

// 0x000000000000000000000000a7b49c0ed293742f6b0640b8b3db068c1e6fbd52;

export const getBscMilkywayMILKWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    milkyway: {
      owner: safeOwners.milkyway,
      type: TokenType.native,
      foreignDeployment:
        '0x726f757465725f61707000000000000000000000000000010000000000000000',
      ...routerConfig.milkway,
    },
    bsc: {
      ...routerConfig.bsc,
      type: TokenType.synthetic,
      owner: safeOwners.bsc,
      symbol: 'MILK',
      name: 'MilkyWay',
      decimals: 6,
      mailbox: '0x2971b9Aec44bE4eb673DF1B88cDB57b96eefe8a4',
      interchainSecurityModule: {
        type: IsmType.FALLBACK_ROUTING,
        owner: safeOwners.bsc,
        domains: buildAggregationIsmConfigs(
          'bsc',
          ['milkyway'],
          defaultMultisigConfigs,
        ),
      },
    },
  };
};
