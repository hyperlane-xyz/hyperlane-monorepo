import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

// TODO: Confirm ownership
const safeOwners: ChainMap<Address> = {
  bsc: '0xE472F601aeEeBEafbbd3a6FD9A788966011AD1Df',
  milkyway: 'milk169dcaz397j75tjfpl6ykm23dfrv39dqd58lsag',
};

export const getBscMilkywayMILKWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    milkyway: {
      ...routerConfig.milkyway,
      owner: safeOwners.milkyway,
      type: TokenType.native,
      foreignDeployment:
        '0x726f757465725f61707000000000000000000000000000010000000000000000',
    },
    bsc: {
      ...routerConfig.bsc,
      owner: safeOwners.bsc,
      type: TokenType.synthetic,
      symbol: 'MILK',
      name: 'MilkyWay',
      decimals: 6,
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
