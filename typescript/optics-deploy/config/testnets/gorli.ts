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

export const chainJson: ChainJson = {
  name: 'gorli',
  rpc,
  deployerKey: process.env.GORLI_DEPLOYER_KEY,
  domain: 5,
  confirmations: 3,
  gasPrice: BigNumber.from(10_000_000_000),
};

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

export const chain = toChain(chainJson);

export const testnetConfig: CoreConfig = {
  environment: 'testnet',
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
