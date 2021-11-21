import { ChainJson, toChain } from '../../src/chain';
import * as dotenv from 'dotenv';
import { CoreConfig } from '../../src/core/CoreDeploy';
import { BridgeConfig } from '../../src/bridge/BridgeDeploy';
import { BigNumber } from 'ethers';

dotenv.config();

const rpc = process.env.AVALANCHE_RPC;
if (!rpc) {
  throw new Error('Missing RPC URI');
}

export const chainJson: ChainJson = {
  name: 'avalanche',
  rpc,
  deployerKey: process.env.AVALANCHE_DEPLOYER_KEY,
  domain: 0x61766178, // b'avax' interpreted as an int
  // This isn't actually used because Avalanche supports EIP 1559 - but just in case
  gasPrice: BigNumber.from(225_000_000_000), // 225 nAVAX (225 gwei)
  // EIP 1559 params
  maxFeePerGas: '225000000000', // 225 nAVAX (225 gwei)
  maxPriorityFeePerGas: '4000000000', // 4 nAVAX (4 gwei)
};

export const chain = toChain(chainJson);

export const config: CoreConfig = {
  environment: 'prod-community',
  updater: '0x6e29236E86a039F8225834F7E7cd4122dc166e51',
  recoveryTimelock: 60 * 60 * 24, // 1 day
  // TODO
  recoveryManager: '0x3D9330014952Bf0A3863FEB7a657bfFA5C9D40B9',
  optimisticSeconds: 60 * 15, // 15 minutes
  watchers: ['0x74C1580f920E4d694502Ca95838d6382caecb1dE'],
  // governor: {},
  processGas: 850_000,
  reserveGas: 15_000,
};

export const bridgeConfig: BridgeConfig = {
  weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Actually WAVAX but ok
};
