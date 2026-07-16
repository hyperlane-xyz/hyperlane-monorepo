import { pick } from '@hyperlane-xyz/utils';

import { getRenzoWarpConfigGenerator, renzoTokenPrices } from './renzo.js';

export const rezEthChainsToDeploy = ['ethereum', 'base', 'unichain'];
const rezProductionLockbox = '0xd8B543fEac4EEcEF5a46a926e10D6f4a72de6fE0';
const rezEthAddresses = {
  ethereum: '0xf757c9804cF2EE8d8Ed64e0A8936293Fe43a7252',
  base: '0xf757c9804cF2EE8d8Ed64e0A8936293Fe43a7252',
  unichain: '0xf757c9804cF2EE8d8Ed64e0A8936293Fe43a7252',
};

export const rezEthValidators = {
  base: {
    threshold: 1,
    validators: [
      { address: '0x25ba4ee5268cbfb8d69bac531aa10368778702bd', alias: 'Renzo' },
      {
        address: '0x9ec803b503e9c7d2611e231521ef3fde73f7a21c',
        alias: 'Everclear',
      },
    ],
  },
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
  unichain: {
    threshold: 1,
    validators: [
      {
        address: '0xa9d517776fe8beba7d67c21cac1e805bd609c08e',
        alias: 'Luganodes',
      },
      { address: '0xfe318024ca6197f2157905209149067a11e6982c', alias: 'Renzo' },
    ],
  },
};

const rezEthSafes: Record<(typeof rezEthChainsToDeploy)[number], string> = {
  base: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
  ethereum: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
  unichain: '0x70aF964829DA7F3f51973EE806AEeAB9225F2661',
};

const rezEthOwners = pick(rezEthSafes, rezEthChainsToDeploy);
const rezEthTokenPrices = pick(renzoTokenPrices, rezEthChainsToDeploy);

export const getREZBaseEthereumWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: rezEthChainsToDeploy,
  validators: rezEthValidators,
  safes: rezEthOwners,
  xERC20Addresses: rezEthAddresses,
  xERC20Lockbox: rezProductionLockbox,
  tokenPrices: rezEthTokenPrices,
});
