import { ChainWithoutSigner, ChainName } from '../src/config/chain';
import { CoreConfig } from '../src/core';
import { GovernanceConfigWithoutCore } from '../src/governance';
import { BridgeConfigWithoutCore } from '../src/bridge';

const testCelo: ChainWithoutSigner = {
  name: ChainName.CELO,
  domain: 1000,
  overrides: {},
};

const testEthereum: ChainWithoutSigner = {
  name: ChainName.ETHEREUM,
  domain: 2000,
  overrides: {},
};

const testPolygon: ChainWithoutSigner = {
  name: ChainName.POLYGON,
  domain: 3000,
  overrides: {},
};

export const testChains = [testCelo, testEthereum, testPolygon];

export const testCore: CoreConfig = {
  processGas: 850_000,
  reserveGas: 15_000,
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
  addresses: {
    // Deployment calls weth.approve()
    /*
    celo: {
      weth: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
    },
    */
  },
};
