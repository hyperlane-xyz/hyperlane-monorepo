import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Common collateral tokens to be used by warp route deployments.
export const tokens: ChainMap<Record<string, Address>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  },
};
