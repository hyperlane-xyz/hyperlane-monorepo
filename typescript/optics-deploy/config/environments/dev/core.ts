import { CoreConfig } from '../../../src/core/CoreDeploy';

export const core: CoreConfig = {
  environment: 'dev',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      updater: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    fuji: {
      updater: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    gorli: {
      updater: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    kovan: {
      updater: '0x2eA2B6cbc3fC269Bf91C2fCfcc460489378f1251',
      watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    mumbai: {
      updater: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
      watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    rinkarby: {
      updater: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      watchers: ['0x20aC2FD664bA5406A7262967C34107e708dCb18E'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      updater: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      watchers: ['0x20aC2FD664bA5406A7262967C34107e708dCb18E'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    ropsten: {
      updater: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
      watchers: ['0x20aC2FD664bA5406A7262967C34107e708dCb18E'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  }
};
