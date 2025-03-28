import { ChainMap } from '@hyperlane-xyz/sdk';
import { pick } from '@hyperlane-xyz/utils';

import {
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
};

export const pzEthChainsToDeploy = ['ethereum', 'swell', 'zircuit'];

const pzEthValidators = pick(ezEthValidators, pzEthChainsToDeploy);
const pzEthSafes = pick(ezEthSafes, pzEthChainsToDeploy);
export const pzEthTokenPrices = pick(renzoTokenPrices, pzEthChainsToDeploy);
const existingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  ethereum: {
    address: '0x4f4671Ce69c9af15e33eB7Cf6D1358d1B39Af3bF',
    owner: '0x81F6e9914136Da1A1d3b1eFd14F7E0761c3d4cc7',
  },
  swell: {
    address: '0xfa656a97b8FD2D7A94a728c0373cfd820b1f0747',
    owner: '0xf25484650484DE3d554fB0b7125e7696efA4ab99',
  },
  zircuit: {
    address: '0x8b789B4A56675240c9f0985B467752b870c75711',
    owner: '0x4D7572040B84b41a6AA2efE4A93eFFF182388F88',
  },
};
export const getRenzoPZETHWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: pzEthChainsToDeploy,
  validators: pzEthValidators,
  safes: pzEthSafes,
  xERC20Addresses: pzEthAddresses,
  xERC20Lockbox: pzEthProductionLockbox,
  tokenPrices: pzEthTokenPrices,
  existingProxyAdmins,
});
