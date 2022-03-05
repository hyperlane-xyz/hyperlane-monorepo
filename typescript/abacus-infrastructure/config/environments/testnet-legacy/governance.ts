import { GovernanceConfig } from '../../../src/config/governance';

export const governance: Omit<GovernanceConfig, 'core'> = {
  recoveryTimelock: 180,
  addresses: {
    alfajores: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    kovan: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkarby: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  },
};
