import { ChainMap } from '@hyperlane-xyz/sdk';
import { pick } from '@hyperlane-xyz/utils';

import {
  ezEthSafes,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
  ownerOverrides,
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

const pzEthValidators = pick(ezEthValidators, pzEthChainsToDeploy);
const pzEthSafes = pick(ezEthSafes, pzEthChainsToDeploy);
export const pzEthTokenPrices = pick(renzoTokenPrices, pzEthChainsToDeploy);

export const getRenzoPZETHWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: pzEthChainsToDeploy,
  validators: pzEthValidators,
  safes: pzEthSafes,
  xERC20Addresses: pzEthAddresses,
  xERC20Lockbox: pzEthProductionLockbox,
  tokenPrices: pzEthTokenPrices,
  ownerOverrides: pick(ownerOverrides, pzEthChainsToDeploy),
});
