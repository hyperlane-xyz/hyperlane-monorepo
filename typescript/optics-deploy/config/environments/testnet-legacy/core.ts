import { CoreConfig } from '../../../src/core/CoreDeploy';

export const core: CoreConfig = {
  environment: 'testnet-legacy',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    kovan: {
      updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkarby: {
      updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  }
};
