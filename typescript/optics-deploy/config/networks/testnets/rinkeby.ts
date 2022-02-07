import * as dotenv from 'dotenv';

import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';

dotenv.config();

const rpc = process.env.RINKEBY_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

const chainJson: ChainConfigJson = {
  name: ChainName.RINKEBY,
  rpc,
  deployerKey: process.env.RINKEBY_DEPLOYER_KEY,
  domain: 2000,
  confirmations: 3,
  weth: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
};

export const chain = new ChainConfig(chainJson);
