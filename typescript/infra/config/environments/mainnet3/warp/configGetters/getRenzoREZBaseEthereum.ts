import { ChainMap } from '@hyperlane-xyz/sdk';
import { pick } from '@hyperlane-xyz/utils';

import {
  ezEthSafes,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
  renzoTokenPrices,
} from './getRenzoEZETHWarpConfig.js';

const rezEthChainsToDeploy = ['ethereum', 'base'];
const rezProductionLockbox = '0xd8B543fEac4EEcEF5a46a926e10D6f4a72de6fE0';
const rezEthAddresses = {
  ethereum: '0xf757c9804cF2EE8d8Ed64e0A8936293Fe43a7252',
  base: '0xf757c9804cF2EE8d8Ed64e0A8936293Fe43a7252',
};

const rezEthValidators = pick(ezEthValidators, rezEthChainsToDeploy);
const rezEthSafes = pick(ezEthSafes, rezEthChainsToDeploy);
const rezEthTokenPrices = pick(renzoTokenPrices, rezEthChainsToDeploy);
const existingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  ethereum: {
    address: '0xef0Adeb4103A7A1AcE86371867202f2171126362',
    owner: ezEthSafes.ethereum,
  },
  base: {
    address: '0x7E4607Fef69d2177f56cE62651fA1aeeB385B2BF',
    owner: ezEthSafes.base,
  },
};
export const getREZBaseEthereumWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: rezEthChainsToDeploy,
  validators: rezEthValidators,
  safes: rezEthSafes,
  xERC20Addresses: rezEthAddresses,
  xERC20Lockbox: rezProductionLockbox,
  tokenPrices: rezEthTokenPrices,
  existingProxyAdmins,
});
