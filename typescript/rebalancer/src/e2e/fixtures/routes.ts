import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export const TEST_CHAINS = ['ethereum', 'arbitrum', 'base'] as const;
export type TestChain = (typeof TEST_CHAINS)[number];

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
};
