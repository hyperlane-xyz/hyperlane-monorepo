import { ChainMap, OwnableConfig, RouterConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Common collateral tokens to be used by warp route deployments.
export const tokens: ChainMap<Record<string, Address>> = {
  ethereum: {
    amphrETH: '0x5fD13359Ba15A84B76f7F87568309040176167cd',
    apxETH: '0x9ba021b0a9b958b5e75ce9f6dff97c7ee52cb3e6',
    cbBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    deUSD: '0x15700B564Ca08D9439C58cA5053166E8317aa138',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    weETHs: '0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88',
  },
  sei: {
    fastUSD: '0x37a4dD9CED2b19Cfe8FAC251cd727b5787E45269',
  },
  base: {
    cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  arbitrum: {
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  bsc: {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    WETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  },
  mantle: {
    USDT: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE',
    WETH: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111',
  },
  mode: {
    USDT: '0xf0F161fDA2712DB8b566946122a5af183995e2eD',
  },
  polygon: {
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  scroll: {
    USDT: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df',
  },
  optimism: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  gnosis: {
    WETH: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1',
  },
  zeronetwork: {
    USDC: '0x6a6394F47DD0BAF794808F2749C09bd4Ee874E70',
  },
};

export type RouterConfigWithoutOwner = Omit<RouterConfig, keyof OwnableConfig>;
