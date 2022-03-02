import { CoreConfig } from '../../../src/config/core';
import { DeployEnvironment } from '../../../src/deploy';

export const core: CoreConfig = {
  environment: DeployEnvironment.testnet,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      validator: '0xf0B3C01E16cE288f7Cd7112B4b2F5A859Ba72307',
      recoveryManager: '0x075fE802D26a983423caE0a16b8250F155AbeB03',
    },
    gorli: {
      validator: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
      recoveryManager: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
    },
    kovan: {
      validator: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
      recoveryManager: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
    },
    ropsten: {
      validator: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
      recoveryManager: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
    },
  },
};
