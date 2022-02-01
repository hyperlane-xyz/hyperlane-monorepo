import * as dotenv from 'dotenv';

import { ChainJson, toChain } from '../../src/chain';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';

dotenv.config();

const rpc = process.env.FUJI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'fuji',
  rpc,
  deployerKey: process.env.FUJI_DEPLOYER_KEY,
  domain: 43113,
  confirmations: 3,
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

export const bridgeConfig: BridgeConfig = {
  weth: '0xd00ae08403b9bbb9124bb305c09058e32c39a48c',
};
