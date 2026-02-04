import { BigNumber } from 'ethers';

import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export const TEST_CHAINS = ['ethereum', 'arbitrum', 'base'] as const;
export type TestChain = (typeof TEST_CHAINS)[number];

export const ANVIL_TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const TEST_TIMEOUT_MS = 300000;

export const DEFAULT_TRANSFER_AMOUNT = BigNumber.from('600000000');

export const USDC_ADDRESSES: Record<TestChain, string> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

export const USDC_INCENTIV_WARP_ROUTE = {
  id: 'USDC/incentiv',
  routers: {
    ethereum: '0x8918b0186136130FE8e02bfB221f23cbBbCDDE07',
    arbitrum: '0x67E26775847da2c066415d7F46fbEEc5C70F6a89',
    base: '0xBBDE7EFB7a1AB3ED9122a14b33dC5C07D982367E',
  } as Record<TestChain, string>,
};

export const USDC_SUPERSEED_WARP_ROUTE = {
  id: 'USDC/superseed',
  routers: {
    ethereum: '0xc927767CF7bddc5e8b996A0f957e5F22250A2F67',
    arbitrum: '0x2cB0E5AbE11346679749063d3FBfC1f390e6e70A',
    base: '0x955132016f9B6376B1392aA7BFF50538d21Ababc',
  } as Record<TestChain, string>,
};

export const USDC_SUBTENSOR_WARP_ROUTE = {
  id: 'USDC/subtensor',
  routers: {
    ethereum: '0xedCBAa585FD0F80f20073F9958246476466205b8',
    arbitrum: '0x8a82186EA618b91D13A2041fb7aC31Bf01C02aD2',
    base: '0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975',
  } as Record<TestChain, string>,
};

export const DOMAIN_IDS: Record<TestChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
};

export const FORK_BLOCK_NUMBERS: Record<TestChain, number> = {
  ethereum: 24348260,
  arbitrum: 426829017,
  base: 41496846,
};

export const TEST_WARP_ROUTE_CONFIG: WarpCoreConfig = {
  tokens: [
    {
      chainName: 'ethereum',
      standard: TokenStandard.EvmHypCollateral,
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin',
      addressOrDenom: USDC_INCENTIV_WARP_ROUTE.routers.ethereum,
      collateralAddressOrDenom: USDC_ADDRESSES.ethereum,
      connections: [
        {
          token: `${ProtocolType.Ethereum}|arbitrum|${USDC_INCENTIV_WARP_ROUTE.routers.arbitrum}`,
        },
        {
          token: `${ProtocolType.Ethereum}|base|${USDC_INCENTIV_WARP_ROUTE.routers.base}`,
        },
      ],
    },
    {
      chainName: 'arbitrum',
      standard: TokenStandard.EvmHypCollateral,
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin',
      addressOrDenom: USDC_INCENTIV_WARP_ROUTE.routers.arbitrum,
      collateralAddressOrDenom: USDC_ADDRESSES.arbitrum,
      connections: [
        {
          token: `${ProtocolType.Ethereum}|ethereum|${USDC_INCENTIV_WARP_ROUTE.routers.ethereum}`,
        },
        {
          token: `${ProtocolType.Ethereum}|base|${USDC_INCENTIV_WARP_ROUTE.routers.base}`,
        },
      ],
    },
    {
      chainName: 'base',
      standard: TokenStandard.EvmHypCollateral,
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin',
      addressOrDenom: USDC_INCENTIV_WARP_ROUTE.routers.base,
      collateralAddressOrDenom: USDC_ADDRESSES.base,
      connections: [
        {
          token: `${ProtocolType.Ethereum}|ethereum|${USDC_INCENTIV_WARP_ROUTE.routers.ethereum}`,
        },
        {
          token: `${ProtocolType.Ethereum}|arbitrum|${USDC_INCENTIV_WARP_ROUTE.routers.arbitrum}`,
        },
      ],
    },
  ],
};

export const BALANCE_PRESETS: Record<string, Record<TestChain, string>> = {
  DEFICIT_ARB: {
    ethereum: '10000000000',
    arbitrum: '100000000',
    base: '5000000000',
  },
  BALANCED: {
    ethereum: '5000000000',
    arbitrum: '5000000000',
    base: '5000000000',
  },
  WEIGHTED_IMBALANCED: {
    ethereum: '7000000000', // 7000 USDC (70%)
    arbitrum: '2000000000', // 2000 USDC (20%)
    base: '1000000000', // 1000 USDC (10%) - needs +1000
  },
  WEIGHTED_WITHIN_TOLERANCE: {
    ethereum: '6100000000', // 6100 USDC (61%)
    arbitrum: '2000000000', // 2000 USDC (20%)
    base: '1900000000', // 1900 USDC (19%)
  },
  BELOW_MIN_ARB: {
    ethereum: '6000000000', // 6000 USDC - higher surplus, will be origin
    arbitrum: '50000000', // 50 USDC - below 100 min
    base: '4000000000', // 4000 USDC
  },
  BELOW_MIN_BASE: {
    ethereum: '6000000000', // 6000 USDC - higher surplus
    arbitrum: '4000000000', // 4000 USDC
    base: '50000000', // 50 USDC - below 100 min
  },
  LOW_BALANCE_ARB: {
    ethereum: '6000000000', // 6000 USDC - higher surplus, will be origin
    arbitrum: '200000000', // 200 USDC - will be -100 with 300 pending TO arb
    base: '4000000000', // 4000 USDC - lower surplus
  },
  COMPOSITE_DEFICIT_IMBALANCE: {
    ethereum: '8000000000', // 8000 USDC - surplus
    arbitrum: '500000000', // 500 USDC - will have deficit with pending transfer
    base: '1500000000', // 1500 USDC - below weighted target
  },
};
