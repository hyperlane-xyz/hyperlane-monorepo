import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Common collateral tokens to be used by warp route deployments.
export const tokens: ChainMap<Record<string, Address>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    deUSD: '0x15700B564Ca08D9439C58cA5053166E8317aa138',
    amphrETH: '0x5fD13359Ba15A84B76f7F87568309040176167cd',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  },
  sei: {
    fastUSD: '0x37a4dD9CED2b19Cfe8FAC251cd727b5787E45269',
  },
};
