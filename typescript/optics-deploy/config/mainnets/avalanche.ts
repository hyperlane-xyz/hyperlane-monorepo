import { ChainJson, toChain } from '../../src/chain';
import * as dotenv from 'dotenv';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.AVALANCHE_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'avalanche',
  rpc,
  deployerKey: process.env.AVALANCHE_DEPLOYER_KEY,
  domain: 0x61766178, // b'avax' interpreted as an int
  gasPrice: BigNumber.from(225_000_000_000),
};

export const chain = toChain(chainJson);

export const config: CoreConfig = {
  environment: 'prod-community',
  updater: '0xDB2091535eb0Ee447Ce170DDC25204FEA822dd81',
  recoveryTimelock: 60 * 60 * 24, // 1 day
  // TODO
  recoveryManager: '0x3D9330014952Bf0A3863FEB7a657bfFA5C9D40B9',
  optimisticSeconds: 60 * 15, // 15 minutes
  watchers: ['0xeE42B7757798cf495CDaA8eDb0CC237F07c60C81'],
  // governor: {},
  processGas: 850_000,
  reserveGas: 15_000,
};

export const bridgeConfig: BridgeConfig = {
  weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Actually WAVAX but ok
};
