import { GovernanceConfigWithoutCore } from '../../../src/governance';

export const governance: GovernanceConfigWithoutCore = {
  recoveryTimelock: 180,
  addresses: {
    alfajores: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    fuji: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    gorli: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    kovan: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    mumbai: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    rinkarby: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    rinkeby: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
    ropsten: {
      recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
    },
  },
};
