import { ChainName } from '../types.js';

export const SEALEVEL_SPL_NOOP_ADDRESS =
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';

/**
 * Priority fees in microlamports for Sealevel chains
 */
export const SEALEVEL_PRIORITY_FEES: Partial<Record<ChainName, number>> = {
  solanamainnet: 200_000,
};
