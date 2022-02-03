import * as dotenv from 'dotenv';

import { ChainJson, toChain } from '../../src/chain';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BigNumber } from 'ethers';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';

dotenv.config();

const rpc = process.env.ROPSTEN_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'ropsten',
  rpc,
  deployerKey: process.env.ROPSTEN_DEPLOYER_KEY,
  domain: 3,
  confirmations: 3,
  gasPrice: BigNumber.from(10_000_000_000),
};

export const chain = toChain(chainJson);

export const devConfig: CoreConfig = {
  environment: 'dev',
  updater: '0x4177372FD9581ceb2367e0Ce84adC5DAD9DF8D55',
  watchers: ['0x20aC2FD664bA5406A7262967C34107e708dCb18E'],
  recoveryManager: '0x24F6c874F56533d9a1422e85e5C7A806ED11c036',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const stagingCommunityConfig: CoreConfig = {
  environment: 'staging-community',
  updater: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
  watchers: ['0x405a8C080Ca64e038554a2B03eA1bdA96DAFA52C'],
  recoveryManager: '0x6f37CaE0b16589FA55152732f2E04f6F0F7dcE97',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const bridgeConfig: BridgeConfig = {
  weth: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
};
