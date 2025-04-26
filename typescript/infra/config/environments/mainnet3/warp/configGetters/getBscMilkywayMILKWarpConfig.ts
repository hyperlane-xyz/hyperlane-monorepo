import {
  AW_VALIDATOR_ALIAS,
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  MultisigConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

// TODO: Confirm ownership
const safeOwners: ChainMap<Address> = {
  bsc: DEPLOYER,
  milkyway: 'milk1326ley07fm6rpeqgxmxevnqevrsjfew2akzupg',
};

const multisigConfig: ChainMap<MultisigConfig> = {
  ...defaultMultisigConfigs,
  milkyway: {
    threshold: 1,
    validators: [
      {
        address: '0x9985e0c6df8e25b655b46a317af422f5e7756875',
        alias: AW_VALIDATOR_ALIAS,
      },
    ],
  },
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
          multisigConfig,
        ),
      },
    },
  };
};
