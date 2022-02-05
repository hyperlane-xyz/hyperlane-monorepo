import * as dotenv from 'dotenv';

import { ChainConfig, ChainConfigJson } from '../../../src/chain';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.KOVAN_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: 'kovan',
  rpc,
  deployerKey: process.env.KOVAN_DEPLOYER_KEY,
  domain: 3000,
  gasPrice: BigNumber.from(10_000_000_000),
  weth: '0xd0a1e359811322d97991e03f863a0c30c2cf029c',
};

export const chain = new ChainConfig(chainJson);
