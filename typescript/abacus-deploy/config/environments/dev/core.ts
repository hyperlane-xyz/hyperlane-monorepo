import { CoreConfig } from '../../../src/config/core';
import { DeployEnvironment } from '../../../src/deploy';

export const core: CoreConfig = {
  environment: DeployEnvironment.dev,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      validator: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    fuji: {
      validator: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    gorli: {
      validator: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    kovan: {
      validator: '0x2eA2B6cbc3fC269Bf91C2fCfcc460489378f1251',
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    mumbai: {
      validator: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    rinkarby: {
      validator: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      validator: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    ropsten: {
      validator: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  },
};
