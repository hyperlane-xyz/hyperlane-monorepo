import * as dotenv from 'dotenv';

import { ChainConfig, ChainConfigJson } from '../../../src/chain';

dotenv.config();

const rpc = process.env.MUMBAI_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: 'mumbai',
  rpc,
  deployerKey: process.env.MUMBAI_DEPLOYER_KEY,
  domain: 80001,
  confirmations: 3,
  weth: '0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889',
};

export const chain = new ChainConfig(chainJson);
