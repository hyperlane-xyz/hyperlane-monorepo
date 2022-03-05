import { CoreConfig } from '@abacus-network/abacus-deploy';

export const core: CoreConfig = {
  processGas: 850_000,
  reserveGas: 15_000,
  validators: {
    alfajores: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    fuji: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    gorli: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    kovan: '0x2eA2B6cbc3fC269Bf91C2fCfcc460489378f1251',
    mumbai: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    rinkarby: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
    rinkeby: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
    ropsten: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
  },
};
