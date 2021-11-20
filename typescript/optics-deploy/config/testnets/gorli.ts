import * as dotenv from 'dotenv';

import { ChainJson, toChain } from '../../src/chain';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BigNumber } from 'ethers';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';

dotenv.config();

const rpc = process.env.GORLI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

const chainJson: ChainJson = {
  name: 'gorli',
  rpc,
  deployerKey: process.env.GORLI_DEPLOYER_KEY,
  domain: 5,
  gasPrice: BigNumber.from(10_000_000_000),
};

export const chain = toChain(chainJson);


export const stagingCommunityConfig: CoreConfig = {
  environment: 'staging-community',
  updater: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
  watchers: ['0x0b2bABd063CDc3e663489e32Bf9F74ACA1C6286f'],
  recoveryManager: '0xDd89dCA09Ef81154dAf919b4d7C33f9d8DCf6c7C',
  optimisticSeconds: 10,
  recoveryTimelock: 180,
  processGas: 850_000,
  reserveGas: 15_000,
};

export const bridgeConfig: BridgeConfig = {
  weth: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6',
};
