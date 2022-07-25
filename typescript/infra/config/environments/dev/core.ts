import { ChainMap, CoreConfig } from '@abacus-network/sdk';

import { DevChains } from './chains';

export const core: ChainMap<DevChains, CoreConfig> = {
  alfajores: {
    validatorManager: {
      validators: [
        '0x4455f6B4c341d48ef8CDBe1b9bE8bb3a63c97a46',
        '0xD3f317f27D71b2A5fF9A1Ee78a1230390f77e714',
        '0x2C503aF4fe1BCb774E842BC0ACaAC5120dDFA560',
      ],
      threshold: 2,
    },
  },
  kovan: {
    validatorManager: {
      validators: [
        '0x16975a2f4c8354A6aeE0ef539b1BfDC8Ff69bD49',
        '0x5f7C587cA4be989a05dd37CCF02D29c71B98F1A9',
        '0xF9d936b2Be7b1800E2B99cd8634c15a8A682fCE3',
      ],
      threshold: 2,
    },
  },
};
