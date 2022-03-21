import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { CoreConfig } from '../src/core';
import { GovernanceConfigWithoutCore } from '../src/governance';
import { BridgeConfigWithoutCore } from '../src/bridge';

export const outputDir = './test/outputs';

export const testGovernance: GovernanceConfigWithoutCore = {
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

export const testBridge: BridgeConfigWithoutCore = {
  weth: {
    // Deployment calls weth.approve()
    // celo: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
};
