import * as dotenv from 'dotenv';

import { ChainName, ChainConfig, ChainConfigJson } from '../../../src/config/chain';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.ROPSTEN_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.ROPSTEN,
  rpc,
  deployerKey: process.env.ROPSTEN_DEPLOYER_KEY,
  domain: 3,
  confirmations: 3,
  gasPrice: BigNumber.from(10_000_000_000),
  weth: '0xc778417E063141139Fce010982780140Aa0cD5Ab',
};

export const chain = new ChainConfig(chainJson);
