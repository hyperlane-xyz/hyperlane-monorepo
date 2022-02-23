import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import * as dotenv from 'dotenv';

dotenv.config();

const rpc = process.env.CELO_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.CELO,
  rpc,
  deployerKey: process.env.CELO_DEPLOYER_KEY,
  domain: 0x63656c6f, // b'celo' interpreted as an int
  updaterInterval: 300,
  updaterPause: 15
};

export const chain = new ChainConfig(chainJson);
