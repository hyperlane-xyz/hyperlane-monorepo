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

const chainJson: ChainJson = {
  name: 'ropsten',
  rpc,
  deployerKey: process.env.ROPSTEN_DEPLOYER_KEY,
  domain: 3,
  gasPrice: BigNumber.from(10_000_000_000),
};

export const chain = toChain(chainJson);


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
