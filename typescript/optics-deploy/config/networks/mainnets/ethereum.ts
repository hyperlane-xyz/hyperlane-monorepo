import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import * as dotenv from 'dotenv';

dotenv.config();

const rpc = process.env.ETHEREUM_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.ETHEREUM,
  rpc,
  deployerKey: process.env.ETHEREUM_DEPLOYER_KEY,
  domain: 0x657468, // b'eth' interpreted as an int
  // This isn't actually used because Ethereum supports EIP 1559 - but just in case
  gasPrice: '400000000000', // 400 gwei
  // EIP 1559 params
  maxFeePerGas: '300000000000', // 300 gwei
  maxPriorityFeePerGas: '4000000000', // 4 gwei
  weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
};

export const chain = new ChainConfig(chainJson);
