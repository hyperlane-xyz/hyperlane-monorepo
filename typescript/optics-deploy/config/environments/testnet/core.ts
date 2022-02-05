import { CoreConfig } from '../../../src/core/CoreDeploy';

export const core: CoreConfig = {
  environment: 'testnet',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      updater: '0xf0B3C01E16cE288f7Cd7112B4b2F5A859Ba72307',
      watchers: ['0xC3Ef93917f0d0AC4D70E675824270b290E0a2667'],
      recoveryManager: '0x075fE802D26a983423caE0a16b8250F155AbeB03',
    },
    gorli: {
      updater: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
      watchers: ['0x0b2bABd063CDc3e663489e32Bf9F74ACA1C6286f'],
      recoveryManager: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
    },
    kovan: {
      updater: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
      watchers: ['0x5830e4a749e0eAEF5955069f12B37Fd82C234c23'],
      recoveryManager: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
    },
    ropsten: {
      updater: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
      watchers: ['0x405a8C080Ca64e038554a2B03eA1bdA96DAFA52C'],
      recoveryManager: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
    },
  }
};
