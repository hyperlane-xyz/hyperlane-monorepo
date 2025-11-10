import { ChainMap } from '@hyperlane-xyz/sdk';
import { pick } from '@hyperlane-xyz/utils';

import {
  ezEthOwners,
  ezEthSafes,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
  renzoTokenPrices,
} from './getRenzoEZETHWarpConfig.js';

const pzEthProductionLockbox = '0xbC5511354C4A9a50DE928F56DB01DD327c4e56d5';
const pzEthAddresses = {
  ethereum: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7',
  zircuit: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7',
  swell: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7',
  unichain: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7',
  berachain: '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7',
};

export const pzEthChainsToDeploy = [
  'ethereum',
  'swell',
  'zircuit',
  'unichain',
  'berachain',
];

const pzEthValidators = {
  ethereum: {
    threshold: 1,
    validators: [
      {
        address: '0x1fd889337f60986aa57166bc5ac121efd13e4fdd',
        alias: 'Everclear',
      },
      { address: '0xc7f7b94a6baf2fffa54dfe1dde6e5fcbb749e04f', alias: 'Renzo' },
    ],
  },
  ...pick(ezEthValidators, ['swell', 'zircuit', 'unichain', 'berachain']),
};
const pzEthSafes = pick(ezEthSafes, pzEthChainsToDeploy);
export const pzEthTokenPrices = pick(renzoTokenPrices, pzEthChainsToDeploy);

export const getRenzoPZETHWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: pzEthChainsToDeploy,
  validators: pzEthValidators,
  safes: pzEthSafes,
  xERC20Addresses: pzEthAddresses,
  xERC20Lockbox: pzEthProductionLockbox,
  tokenPrices: pzEthTokenPrices,
});
