import { ChainName, ChainConfig, ChainConfigJson } from '../../../src/config/chain';
import * as dotenv from 'dotenv';

dotenv.config();

const rpc = process.env.ALFAJORES_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.ALFAJORES,
  rpc,
  deployerKey: process.env.ALFAJORES_DEPLOYER_KEY,
  domain: 1000,
  confirmations: 1,
};

export const chain = new ChainConfig(chainJson);
