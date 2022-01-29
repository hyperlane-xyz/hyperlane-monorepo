import { ChainJson, toChain } from '../../src/chain';
import * as dotenv from 'dotenv';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';

dotenv.config();

const rpc = process.env.ALFAJORES_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'alfajores',
  rpc,
  deployerKey: process.env.ALFAJORES_DEPLOYER_KEY,
  domain: 1000,
  confirmations: 1,
};

export const chain = toChain(chainJson);

export const devConfig: CoreConfig = {
  environment: 'dev',
  updater: '0x91631845fab02614e53e5F5A68dFBB0E2f1a9B6d',
  watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
  recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const stagingConfig: CoreConfig = {
  environment: 'staging',
  updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
  watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
  recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const stagingCommunityConfig: CoreConfig = {
  environment: 'staging-community',
  updater: '0x075fE802D26a983423caE0a16b8250F155AbeB03',
  watchers: ['0xC3Ef93917f0d0AC4D70E675824270b290E0a2667'],
  recoveryManager: '0x075fE802D26a983423caE0a16b8250F155AbeB03',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
}

export const bridgeConfig: BridgeConfig = {};
