import {
  ChainName,
  ChainConfig,
  ChainConfigJson,
} from '../../../src/config/chain';
import * as dotenv from 'dotenv';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.AVALANCHE_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainConfigJson = {
  name: ChainName.AVALANCHE,
  rpc,
  deployerKey: process.env.AVALANCHE_DEPLOYER_KEY,
  domain: 0x61766178, // b'avax' interpreted as an int
  // This isn't actually used because Avalanche supports EIP 1559 - but just in case
  gasPrice: BigNumber.from(50_000_000_000), // 50 nAVAX (50 gwei)
  // EIP 1559 params
  maxFeePerGas: '50000000000', // 50 nAVAX (50 gwei)
  maxPriorityFeePerGas: '10000000000', // 10 nAVAX (10 gwei)
  weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Actually WAVAX but ok
  updaterInterval: 300
};

export const chain = new ChainConfig(chainJson);
