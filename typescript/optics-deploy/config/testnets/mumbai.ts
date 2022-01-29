import * as dotenv from 'dotenv';

import { ChainJson, toChain } from '../../src/chain';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';

dotenv.config();

const rpc = process.env.MUMBAI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'mumbai',
  rpc,
  deployerKey: process.env.MUMBAI_DEPLOYER_KEY,
  domain: 80001,
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
  weth: '0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889',
};
