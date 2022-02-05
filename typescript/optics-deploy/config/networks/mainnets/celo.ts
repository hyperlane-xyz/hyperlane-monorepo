import { ChainConfig, ChainConfigJson } from '../../../src/chain';
import * as dotenv from 'dotenv';

dotenv.config();

const rpc = process.env.CELO_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: 'celo',
  rpc,
  deployerKey: process.env.CELO_DEPLOYER_KEY,
  domain: 0x63656c6f, // b'celo' interpreted as an int
};

export const chain = new ChainConfig(chainJson);
