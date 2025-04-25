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
  bsc: '0x2313057ba402C55dAE1a1E8086B37fc6Ef7B3503',
  milkyway: '0x5A2ee9A4B4D6076cDb3a08c9ae5aca1bD8AD3b02',
};

const validators: ChainMap<MultisigConfig> = {
  milkyway: {
    // TODO
    threshold: 1,
    validators: [
      {
        address: '0x9bccfad3bd12ef0ee8ae839dd9ed7835bccadc9d',
        alias: 'Everclear',
      },
      { address: '0xc27032c6bbd48c20005f552af3aaa0dbf14260f3', alias: 'Renzo' },
    ],
  },
};

export const getBscMilkywayMILKWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return {
    milkyway: {
      ...routerConfig.milkyway,
      owner: '',
      type: TokenType.native,
      foreignDeployment:
        '0x726f757465725f61707000000000000000000000000000010000000000000000',
      gas: 200000,
    },
    bsc: {
      ...routerConfig.bsc,
      type: TokenType.collateral,
      owner: safeOwners.bsc,
      token: tokens.mint.MINT,
      interchainSecurityModule: {
        type: IsmType.ROUTING,
        owner: '',
        domains: buildAggregationIsmConfigs(
          'bsc',
          ['bsc', 'milkyway'],
          validators,
        ),
      },
    },
  };
};
