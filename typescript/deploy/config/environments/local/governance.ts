import { GovernanceConfigWithoutCore } from '../../../src/governance';

export const governance: GovernanceConfigWithoutCore = {
  recoveryTimelock: 180,
  addresses: {
    celo: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
      governor: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    polygon: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    ethereum: {
      recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
  },
};
