import { BigNumber } from 'ethers';

import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// Synthetic test chain configurations
export const TEST_CHAIN_CONFIGS = [
  { name: 'anvil1', chainId: 31337, domainId: 31337 },
  { name: 'anvil2', chainId: 31338, domainId: 31338 },
  { name: 'anvil3', chainId: 31339, domainId: 31339 },
] as const;

export type TestChain = (typeof TEST_CHAIN_CONFIGS)[number]['name'];
export const TEST_CHAINS: readonly TestChain[] = TEST_CHAIN_CONFIGS.map(
  (c) => c.name,
) as unknown as readonly TestChain[];

export const DOMAIN_IDS: Record<TestChain, number> = Object.fromEntries(
  TEST_CHAIN_CONFIGS.map((c) => [c.name, c.domainId]),
) as Record<TestChain, number>;

// Warp route identifiers (used in RebalancerConfig)
export const MONITORED_ROUTE_ID = 'USDC/test-monitored';
export const BRIDGE_ROUTE_1_ID = 'USDC/test-bridge-1';
export const BRIDGE_ROUTE_2_ID = 'USDC/test-bridge-2';

// Deployed contract addresses (populated by LocalDeploymentManager)
export interface ChainDeployment {
  mailbox: string;
  ism: string;
  token: string;
  monitoredRouter: string;
  bridgeRouter1: string;
  bridgeRouter2: string;
}

export interface DeployedAddresses {
  chains: Record<TestChain, ChainDeployment>;
  monitoredRoute: Record<TestChain, string>; // shorthand: chain -> monitored router address
  bridgeRoute1: Record<TestChain, string>; // shorthand: chain -> bridge1 router address
  bridgeRoute2: Record<TestChain, string>; // shorthand: chain -> bridge2 router address
  tokens: Record<TestChain, string>; // shorthand: chain -> token address
}

// Build WarpCoreConfig dynamically from deployed addresses
export function buildWarpRouteConfig(
  addresses: DeployedAddresses,
): WarpCoreConfig {
  const chains = TEST_CHAIN_CONFIGS;
  return {
    tokens: chains.map((chain) => ({
      chainName: chain.name,
      standard: TokenStandard.EvmHypCollateral,
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin',
      addressOrDenom: addresses.monitoredRoute[chain.name],
      collateralAddressOrDenom: addresses.tokens[chain.name],
      connections: chains
        .filter((other) => other.name !== chain.name)
        .map((other) => ({
          token: `${ProtocolType.Ethereum}|${other.name}|${addresses.monitoredRoute[other.name]}`,
        })),
    })),
  };
}

export const ANVIL_TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const ANVIL_USER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export const TEST_TIMEOUT_MS = 300000;

export const DEFAULT_TRANSFER_AMOUNT = BigNumber.from('600000000');

export const BALANCE_PRESETS: Record<string, Record<TestChain, string>> = {
  DEFICIT_ARB: {
    anvil1: '10000000000',
    anvil2: '100000000',
    anvil3: '5000000000',
  },
  BALANCED: {
    anvil1: '5000000000',
    anvil2: '5000000000',
    anvil3: '5000000000',
  },
  WEIGHTED_IMBALANCED: {
    anvil1: '7000000000', // 7000 USDC (70%)
    anvil2: '2000000000', // 2000 USDC (20%)
    anvil3: '1000000000', // 1000 USDC (10%) - needs +1000
  },
  WEIGHTED_WITHIN_TOLERANCE: {
    anvil1: '6100000000', // 6100 USDC (61%)
    anvil2: '2000000000', // 2000 USDC (20%)
    anvil3: '1900000000', // 1900 USDC (19%)
  },
  BELOW_MIN_ARB: {
    anvil1: '6000000000', // 6000 USDC - higher surplus, will be origin
    anvil2: '50000000', // 50 USDC - below 100 min
    anvil3: '4000000000', // 4000 USDC
  },
  BELOW_MIN_BASE: {
    anvil1: '6000000000', // 6000 USDC - higher surplus
    anvil2: '4000000000', // 4000 USDC
    anvil3: '50000000', // 50 USDC - below 100 min
  },
  LOW_BALANCE_ARB: {
    anvil1: '6000000000', // 6000 USDC - higher surplus, will be origin
    anvil2: '200000000', // 200 USDC - will be -100 with 300 pending TO arb
    anvil3: '4000000000', // 4000 USDC - lower surplus
  },
  COMPOSITE_DEFICIT_IMBALANCE: {
    anvil1: '8000000000', // 8000 USDC - surplus
    anvil2: '500000000', // 500 USDC - will have deficit with pending transfer
    anvil3: '1500000000', // 1500 USDC - below weighted target
  },
};
