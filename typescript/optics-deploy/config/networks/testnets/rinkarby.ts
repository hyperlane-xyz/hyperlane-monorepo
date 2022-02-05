import * as dotenv from 'dotenv';

import { ChainName, ChainConfig, ChainConfigJson } from '../../../src/config/chain';

dotenv.config();

const rpc = process.env.RINKARBY_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

const chainJson: ChainConfigJson = {
  name: ChainName.RINKARBY,
  rpc,
  deployerKey: process.env.RINKARBY_DEPLOYER_KEY,
  domain: 4000,
  gasPrice: 0,
  gasLimit: 600_000_000,
  // weth: 'TODO',
};

export const chain = new ChainConfig(chainJson);
