import { ChainConfig, ChainConfigJson } from '../../../src/chain';
import * as dotenv from 'dotenv';

dotenv.config();

const rpc = process.env.POLYGON_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: 'polygon',
  rpc,
  deployerKey: process.env.POLYGON_DEPLOYER_KEY,
  domain: 0x706f6c79, // b'poly' interpreted as an int
  gasPrice: '5000000000', // 50 gwei
  weth: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // Actually WMATIC but ok
};

export const chain = new ChainConfig(chainJson);
