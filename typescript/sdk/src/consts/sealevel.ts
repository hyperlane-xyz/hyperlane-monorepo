import type { ChainMap } from '../types.js';

export const SEALEVEL_SPL_NOOP_ADDRESS =
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';

export const solanaChainToClusterName: ChainMap<string> = {
  solana: 'mainnet-beta',
  solanadevnet: 'devnet',
  solanatestnet: 'testnet',
};
