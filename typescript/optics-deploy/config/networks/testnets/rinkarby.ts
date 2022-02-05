import * as dotenv from 'dotenv';

import { ChainConfig, ChainConfigJson } from '../../../src/chain';

dotenv.config();

const rpc = process.env.RINKARBY_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

const chainJson: ChainConfigJson = {
  name: 'rinkarby',
  rpc,
  deployerKey: process.env.RINKARBY_DEPLOYER_KEY,
  domain: 4000,
  gasPrice: 0,
  gasLimit: 600_000_000,
  // weth: 'TODO',
};

export const chain = new ChainConfig(chainJson);
