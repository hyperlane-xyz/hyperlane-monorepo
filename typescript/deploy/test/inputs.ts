import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  ChainConfigWithoutSigner,
  ChainName,
  ChainConfig,
} from '../src/config';
import { CoreConfig } from '../src/core';
import { GovernanceConfigWithoutCore } from '../src/governance';
import { BridgeConfigWithoutCore } from '../src/bridge';

export const outputDir = './test/outputs';

const testCelo: ChainConfigWithoutSigner = {
  name: ChainName.CELO,
  domain: 1000,
  overrides: {},
};

const testEthereum: ChainConfigWithoutSigner = {
  name: ChainName.ETHEREUM,
  domain: 2000,
  overrides: {},
};

const testPolygon: ChainConfigWithoutSigner = {
  name: ChainName.POLYGON,
  domain: 3000,
  overrides: {},
};

export const testCore: CoreConfig = {
  validators: {
    celo: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    polygon: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
    ethereum: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
  },
};

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

export function getTestChains(
  signer: ethers.Signer,
): Record<types.Domain, ChainConfig> {
  const testChains: Record<types.Domain, ChainConfig> = {};
  const chains = [testCelo, testEthereum, testPolygon];
  chains.map((chain) => {
    testChains[chain.domain] = { ...chain, signer };
  });
  return testChains;
}
