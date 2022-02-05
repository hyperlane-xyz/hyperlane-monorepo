import * as dotenv from 'dotenv';
import { ChainName, ChainConfig, ChainConfigJson } from '../../../src/config/chain';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.GORLI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.GORLI,
  rpc,
  deployerKey: process.env.GORLI_DEPLOYER_KEY,
  domain: 5,
  confirmations: 3,
  gasPrice: BigNumber.from(10_000_000_000),
  weth: '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6',
};

export const chain = new ChainConfig(chainJson);
