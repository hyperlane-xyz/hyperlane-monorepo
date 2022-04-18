import { ethers } from 'ethers';
import { GovernanceConfig } from '../../../src/governance';

const addresses = {
  alfajores: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    governor: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
  kovan: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    governor: ethers.constants.AddressZero,
  },
  mumbai: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    governor: ethers.constants.AddressZero,
  },
  fuji: {
    recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    governor: ethers.constants.AddressZero,
  },
};

export const governance: GovernanceConfig<keyof typeof addresses> = {
  recoveryTimelock: 180,
  addresses,
};
