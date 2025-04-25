import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  MultisigConfig,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// TODO: Confirm ownership
const safeOwners: ChainMap<Address> = {
  bsc: '',
  milkyway: '',
  ism: '',
};

const validators: ChainMap<MultisigConfig> = {
  milkyway: {
    threshold: 1,
    validators: [
      { address: '0x242d8a855a8c932dec51f7999ae7d1e48b10c95e', alias: 'AW' },
      { address: '0xf620f5e3d25a3ae848fec74bccae5de3edcd8796', alias: 'AW' },
      { address: '0x1f030345963c54ff8229720dd3a711c15c554aeb}', alias: 'AW' },
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
      name: 'Milkyway',
      decimals: 9,
      mailbox: '0xF9F6F5646F478d5ab4e20B0F910C92F1CCC9Cc6D',
      interchainSecurityModule: {
        type: IsmType.ROUTING,
        owner: safeOwners.ism,
        domains: buildAggregationIsmConfigs('bsc', ['milkyway'], validators),
      },
    },
  };
};
