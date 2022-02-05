import * as dotenv from 'dotenv';
import { ChainConfig, ChainConfigJson } from '../../../src/chain';

dotenv.config();

const rpc = process.env.FUJI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: 'fuji',
  rpc,
  deployerKey: process.env.FUJI_DEPLOYER_KEY,
  domain: 43113,
  confirmations: 3,
  weth: '0xd00ae08403b9bbb9124bb305c09058e32c39a48c',
};

export const chain = new ChainConfig(chainJson);
