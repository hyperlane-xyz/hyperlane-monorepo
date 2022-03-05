import { GovernanceConfigWithoutCore } from '../../../src/governance';

export const governance: GovernanceConfigWithoutCore = {
  recoveryTimelock: 180,
  addresses: {
    alfajores: {
      recoveryManager: '0x075fE802D26a983423caE0a16b8250F155AbeB03',
    },
    gorli: {
      recoveryManager: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
    },
    kovan: {
      recoveryManager: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
    },
    ropsten: {
      recoveryManager: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
    },
  },
};
