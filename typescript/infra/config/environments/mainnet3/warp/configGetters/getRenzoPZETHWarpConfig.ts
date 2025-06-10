import { ChainMap } from '@hyperlane-xyz/sdk';
import { pick } from '@hyperlane-xyz/utils';

import {
  ezEthProdExistingProtocolFeeAddresses,
  ezEthSafes,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
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
export const pzEthExistingProtocolFee = pick(
  ezEthProdExistingProtocolFeeAddresses,
  pzEthChainsToDeploy,
);
const existingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  ethereum: {
    address: '0x4f4671Ce69c9af15e33eB7Cf6D1358d1B39Af3bF',
    owner: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
  },
  zircuit: {
    address: '0x8b789B4A56675240c9f0985B467752b870c75711',
    owner: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
  },
};

export const getRenzoPZETHWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: pzEthChainsToDeploy,
  validators: pzEthValidators,
  safes: pzEthSafes,
  xERC20Addresses: pzEthAddresses,
  xERC20Lockbox: pzEthProductionLockbox,
  existingProxyAdmins: existingProxyAdmins,
  existingProtocolFee: pzEthExistingProtocolFee,
  useLegacyHooks: true,
});
