import { GovernanceConfig } from '../../../src/governance';

const addresses = {
  test1: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    governor: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
  test2: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
  test3: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
};

export const governance: GovernanceConfig<keyof typeof addresses> = {
  recoveryTimelock: 180,
  addresses,
};
