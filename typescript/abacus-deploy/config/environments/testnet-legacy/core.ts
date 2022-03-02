import { CoreConfig } from '../../../src/config/core';
import { DeployEnvironment } from '../../../src/deploy';

export const core: CoreConfig = {
  environment: DeployEnvironment.testnetLegacy,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
  addresses: {
    alfajores: {
      validator: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    kovan: {
      validator: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkarby: {
      validator: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      validator: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  },
};
