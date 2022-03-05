import { CoreConfig } from '@abacus-network/abacus-deploy';

export const core: CoreConfig = {
  processGas: 850_000,
  reserveGas: 15_000,
  validators: {
    alfajores: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
    kovan: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
    rinkarby: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
    rinkeby: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
  },
};
