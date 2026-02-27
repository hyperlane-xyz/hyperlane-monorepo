import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../../config/types.js';

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
export const NATIVE_MONITORED_ROUTE_ID = 'ETH/test-native-monitored';
export const NATIVE_BRIDGE_ROUTE_ID = 'ETH/test-native-bridge';
export const ERC20_INVENTORY_MONITORED_ROUTE_ID =
  'USDC/test-erc20-inventory-monitored';
export const ERC20_INVENTORY_BRIDGE_ROUTE_ID =
  'USDC/test-erc20-inventory-bridge';

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

// Native chain deployment (for ETH/native routes)
export interface NativeChainDeployment {
  mailbox: string;
  ism: string;
  monitoredRouter: string;
  bridgeRouter: string;
}

export interface NativeDeployedAddresses {
  chains: Record<TestChain, NativeChainDeployment>;
  monitoredRoute: Record<TestChain, string>; // shorthand: chain -> monitored router address
  bridgeRoute: Record<TestChain, string>; // shorthand: chain -> bridge router address
}

export interface Erc20InventoryChainDeployment {
  mailbox: string;
  ism: string;
  monitoredRouter: string;
  bridgeRouter: string;
  token: string;
}

export interface Erc20InventoryDeployedAddresses {
  chains: Record<TestChain, Erc20InventoryChainDeployment>;
  monitoredRoute: Record<TestChain, string>; // shorthand: chain -> monitored router address
  bridgeRoute: Record<TestChain, string>; // shorthand: chain -> bridge router address
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

// Build WarpCoreConfig for native ETH routes
export function buildNativeWarpRouteConfig(
  addresses: NativeDeployedAddresses,
): WarpCoreConfig {
  const chains = TEST_CHAIN_CONFIGS;
  return {
    tokens: chains.map((chain) => ({
      chainName: chain.name,
      standard: TokenStandard.EvmHypNative,
      decimals: 18,
      symbol: 'ETH',
      name: 'Ether',
      addressOrDenom: addresses.monitoredRoute[chain.name],
      connections: chains
        .filter((other) => other.name !== chain.name)
        .map((other) => ({
          token: `${ProtocolType.Ethereum}|${other.name}|${addresses.monitoredRoute[other.name]}`,
        })),
    })),
  };
}

export function buildErc20InventoryWarpRouteConfig(
  addresses: Erc20InventoryDeployedAddresses,
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

export const DEFAULT_TRANSFER_AMOUNT = 600000000n;

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
  INVENTORY_BALANCED: {
    anvil1: '5000000000000000000',
    anvil2: '5000000000000000000',
    anvil3: '5000000000000000000',
  },
  INVENTORY_PARTIAL: {
    anvil1: '5000000000000000000',
    anvil2: '2000000000000000000',
    anvil3: '5000000000000000000',
  },
  INVENTORY_EMPTY_DEST: {
    anvil1: '5000000000000000000',
    anvil2: '0',
    anvil3: '5000000000000000000',
  },
  INVENTORY_MULTI_SOURCE: {
    anvil1: '3000000000000000000',
    anvil2: '0',
    anvil3: '3000000000000000000',
  },
  INVENTORY_MULTI_DEFICIT: {
    anvil1: '6000000000000000000', // 6 ETH - sole surplus source
    anvil2: '0', // deficit
    anvil3: '0', // deficit
  },
  INVENTORY_WEIGHTED_IMBALANCED: {
    anvil1: '7000000000000000000',
    anvil2: '2000000000000000000',
    anvil3: '1000000000000000000',
  },
  ERC20_INVENTORY_BALANCED: {
    anvil1: '5000000000',
    anvil2: '5000000000',
    anvil3: '5000000000',
  },
  ERC20_INVENTORY_PARTIAL: {
    anvil1: '5000000000',
    anvil2: '2000000000',
    anvil3: '5000000000',
  },
  ERC20_INVENTORY_EMPTY_DEST: {
    anvil1: '5000000000',
    anvil2: '0',
    anvil3: '5000000000',
  },
  ERC20_INVENTORY_MULTI_SOURCE: {
    anvil1: '3000000000',
    anvil2: '0',
    anvil3: '3000000000',
  },
  ERC20_INVENTORY_WEIGHTED_IMBALANCED: {
    anvil1: '7000000000',
    anvil2: '2000000000',
    anvil3: '1000000000',
  },
  ERC20_INVENTORY_MULTI_DEFICIT: {
    anvil1: '6000000000', // 6000 USDC - sole surplus source
    anvil2: '0', // deficit
    anvil3: '0', // deficit
  },
  ERC20_INVENTORY_WEIGHTED_ALL_ANVIL1: {
    anvil1: '10000000000', // 10000 USDC - all on anvil1
    anvil2: '0',
    anvil3: '0',
  },
  ERC20_INVENTORY_WEIGHTED_PARTIAL_SUPPLY: {
    anvil1: '4800000000', // 4800 USDC
    anvil2: '1200000000', // 1200 USDC
    anvil3: '0',
  },
  INVENTORY_WEIGHTED_ALL_ANVIL1: {
    anvil1: '10000000000000000000',
    anvil2: '0',
    anvil3: '0',
  },
  INVENTORY_WEIGHTED_PARTIAL_SUPPLY: {
    anvil1: '4800000000000000000',
    anvil2: '1200000000000000000',
    anvil3: '0',
  },
};

// Inventory signer balance presets (ETH balances for the inventory signer wallet)
export const INVENTORY_SIGNER_PRESETS: Record<
  string,
  Partial<Record<TestChain, string>>
> = {
  SIGNER_PARTIAL_ANVIL2: {
    anvil2: '500000000000000000', // 0.5 ETH — forces partial deposit on anvil2
  },
  SIGNER_LOW_ALL: {
    anvil1: '1000000000000000000', // 1 ETH
    anvil2: '300000000000000000', // 0.3 ETH
    anvil3: '1000000000000000000', // 1 ETH
  },
  SIGNER_ONLY_ANVIL1: {
    anvil1: '2000000000000000000', // 2 ETH
    anvil2: '0',
    anvil3: '0',
  },
  SIGNER_SPLIT_SOURCES: {
    anvil1: '1200000000000000000', // 1.2 ETH
    anvil2: '0',
    anvil3: '1200000000000000000', // 1.2 ETH
  },
  SIGNER_FUNDED_ANVIL1: {
    anvil1: '5000000000000000000', // 5 ETH — enough for bridge + gas
    anvil2: '0',
    anvil3: '0',
  },
  SIGNER_PARTIAL_ANVIL3: {
    anvil3: '500000000000000000', // 0.5 ETH — forces partial deposit on anvil3
  },
  SIGNER_ZERO_ANVIL3: {
    anvil3: '0',
  },
  SIGNER_WEIGHTED_LOW_ALL: {
    anvil1: '800000000000000000', // 0.8 ETH
    anvil2: '800000000000000000', // 0.8 ETH
    anvil3: '500000000000000000', // 0.5 ETH
  },
  SIGNER_WEIGHTED_BRIDGE_SOURCES: {
    anvil1: '600000000000000000', // 0.6 ETH
    anvil2: '600000000000000000', // 0.6 ETH
    anvil3: '300000000000000000', // 0.3 ETH
  },
  ERC20_SIGNER_PARTIAL_ANVIL2: {
    anvil2: '50000000', // 50 USDC — forces partial deposit on anvil2
  },
  ERC20_SIGNER_LOW_ALL: {
    anvil1: '100000000', // 100 USDC
    anvil2: '30000000', // 30 USDC
    anvil3: '100000000', // 100 USDC
  },
  ERC20_SIGNER_FUNDED_ANVIL1: {
    anvil1: '500000000', // 500 USDC — enough for bridge
    anvil2: '0',
    anvil3: '0',
  },
  ERC20_SIGNER_SPLIT_SOURCES: {
    anvil1: '120000000', // 120 USDC
    anvil2: '0',
    anvil3: '120000000', // 120 USDC
  },
  ERC20_SIGNER_ZERO_ANVIL3: {
    anvil3: '0',
  },
  ERC20_SIGNER_PARTIAL_ANVIL3: {
    anvil3: '50000000', // 50 USDC — forces partial deposit on anvil3
  },
  ERC20_SIGNER_WEIGHTED_LOW_ALL: {
    anvil1: '800000000', // 800 USDC
    anvil2: '800000000', // 800 USDC
    anvil3: '500000000', // 500 USDC
  },
  ERC20_SIGNER_WEIGHTED_BRIDGE_SOURCES: {
    anvil1: '600000000', // 600 USDC
    anvil2: '600000000', // 600 USDC
    anvil3: '300000000', // 300 USDC
  },
};

// The min/target values used by buildInventoryMinAmountStrategyConfig below.
// Exported so tests can derive expected deficit amounts instead of hardcoding.
export const INVENTORY_MIN_AMOUNT_MIN = '1';
export const INVENTORY_MIN_AMOUNT_TARGET = '2';
export const INVENTORY_MIN_AMOUNT_TARGET_WEI =
  BigInt(INVENTORY_MIN_AMOUNT_TARGET) * 10n ** 18n;

// Weighted strategy deficit constants
export const WEIGHTED_EXPECTED_DEFICIT_1ETH = 1_000_000_000_000_000_000n;
export const WEIGHTED_EXPECTED_DEFICIT_2ETH = 2_000_000_000_000_000_000n;
export const WEIGHTED_EXPECTED_DEFICIT_1_2ETH = 1_200_000_000_000_000_000n;

// ERC20 inventory deficit constants (USDC, 6 decimals)
export const ERC20_INVENTORY_MIN_AMOUNT_TARGET_RAW = 200000000n; // 200 USDC
export const ERC20_WEIGHTED_EXPECTED_DEFICIT_1000USDC = 1000000000n; // 1000 USDC
export const ERC20_WEIGHTED_EXPECTED_DEFICIT_2000USDC = 2000000000n; // 2000 USDC
export const ERC20_WEIGHTED_EXPECTED_DEFICIT_1200USDC = 1200000000n; // 1200 USDC

export function buildInventoryMinAmountStrategyConfig(
  _addresses: NativeDeployedAddresses,
): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: INVENTORY_MIN_AMOUNT_MIN,
            target: INVENTORY_MIN_AMOUNT_TARGET,
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: INVENTORY_MIN_AMOUNT_MIN,
            target: INVENTORY_MIN_AMOUNT_TARGET,
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: INVENTORY_MIN_AMOUNT_MIN,
            target: INVENTORY_MIN_AMOUNT_TARGET,
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

export function buildInventoryWeightedStrategyConfig(
  _addresses: NativeDeployedAddresses,
): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        anvil1: {
          weighted: { weight: 60n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          weighted: { weight: 20n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          weighted: { weight: 20n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

export function buildErc20InventoryMinAmountStrategyConfig(
  _addresses: Erc20InventoryDeployedAddresses,
): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: '100',
            target: '200',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: '100',
            target: '200',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: '100',
            target: '200',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

export function buildErc20InventoryWeightedStrategyConfig(
  _addresses: Erc20InventoryDeployedAddresses,
): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        anvil1: {
          weighted: { weight: 60n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          weighted: { weight: 20n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          weighted: { weight: 20n, tolerance: 5n },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}
