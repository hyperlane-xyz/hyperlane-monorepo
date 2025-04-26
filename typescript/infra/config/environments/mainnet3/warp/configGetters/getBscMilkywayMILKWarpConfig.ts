import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  MultisigConfig,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// TODO: Confirm ownership
const safeOwners: ChainMap<Address> = {
  bsc: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
  milkyway: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
  ism: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
};

const validators: ChainMap<MultisigConfig> = {
  milkyway: {
    threshold: 1,
    validators: [
      { address: '0x9985e0c6df8e25b655b46a317af422f5e7756875', alias: 'AW' },
    ],
  },
};

export const getBscMilkywayMILKWarpConfig = async (
  _: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    milkyway: {
      owner: safeOwners.milkyway,
      type: TokenType.native,
      mailbox:
        '0x68797065726c616e650000000000000000000000000000000000000000000000',
      foreignDeployment:
        '0x726f757465725f61707000000000000000000000000000010000000000000000',
      gas: 200000,
    },
    bsc: {
      type: TokenType.synthetic,
      owner: safeOwners.bsc,
      symbol: 'MILK',
      name: 'MilkyWay',
      decimals: 6,
      mailbox: '0x2971b9Aec44bE4eb673DF1B88cDB57b96eefe8a4',
      interchainSecurityModule: {
        type: IsmType.ROUTING,
        owner: safeOwners.ism,
        domains: buildAggregationIsmConfigs('bsc', ['milkyway'], validators),
      },
    },
  };
};
