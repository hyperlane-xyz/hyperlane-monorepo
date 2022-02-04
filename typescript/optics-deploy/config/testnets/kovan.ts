import * as dotenv from 'dotenv';

import { ChainJson, toChain } from '../../src/chain';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.KOVAN_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'kovan',
  rpc,
  deployerKey: process.env.KOVAN_DEPLOYER_KEY,
  domain: 3000,
  gasPrice: BigNumber.from(10_000_000_000),
};

export const chain = toChain(chainJson);

export const devConfig: CoreConfig = {
  environment: 'dev',
  updater: '0x2eA2B6cbc3fC269Bf91C2fCfcc460489378f1251',
  optimisticSeconds: 10,
  watchers: ['0x3019Bf39Df97942F2C53EFc6e831b82D158593CF'],
  recoveryTimelock: 180,
  recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  processGas: 850_000,
  reserveGas: 15_000,
};

export const testnetLegacyConfig: CoreConfig = {
  environment: 'testnet-legacy',
  updater: '0x201dd86063Dc251cA5a576d1b7365C38e5fB4CD5',
  watchers: ['0x22B2855635154Baa41C306BcA979C8c9a077A180'],
  recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const testnetConfig: CoreConfig = {
  environment: 'testnet',
  updater: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
  watchers: ['0x5830e4a749e0eAEF5955069f12B37Fd82C234c23'],
  recoveryManager: '0xED576b49c3bD42862340e21a7A0AcCA3814bfE18',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const bridgeConfig: BridgeConfig = {
  weth: '0xd0a1e359811322d97991e03f863a0c30c2cf029c',
};
