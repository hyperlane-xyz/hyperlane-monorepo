import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  type Erc20InventoryChainDeployment,
  TEST_CHAIN_CONFIGS,
  TEST_CHAINS,
  type TestChain,
} from './routes.js';
import { SVM_CHAIN_NAME } from './svm-routes.js';
import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../../config/types.js';

// ── USDC constants (6 decimals) ──
export const USDC_DECIMALS = 6;
export const SPL_USDC_DECIMALS = 6; // same on SVM — no conversion needed
export const USDC_INITIAL_SUPPLY = '100000000000000'; // 100,000,000 USDC (6 decimals)
export const USDC_ROUTER_SEED = '10000000000'; // 10,000 USDC per router
export const USDC_BRIDGE_SEED = '10000000000'; // 10,000 USDC for bridge router
export const USDC_SIGNER_SEED = '20000000000'; // 20,000 USDC for inventory signer
export const SPL_ESCROW_SEED = BigInt('10000000000'); // 10,000 USDC in SPL tokens
export const SPL_SIGNER_SEED = BigInt('20000000000'); // 20,000 USDC for SVM signer

// ── Collateral warp route identifier ──
export const SVM_COLLATERAL_MONITORED_ROUTE_ID =
  'USDC/test-svm-evm-collateral-monitored';

// ── SVM collateral deployed addresses ──
export interface SvmCollateralDeployedAddresses {
  mailbox: string;
  ism: string;
  warpRouter: string; // Collateral warp route program ID
  escrowPda: string; // Escrow PDA that holds locked SPL tokens
  splMint: string; // SPL token mint address
  bridgeRouter?: string; // Bridge collateral warp route program ID
  bridgeEscrowPda?: string; // Bridge escrow PDA
}

// ── Combined EVM ERC20 + SVM collateral deployed addresses ──
export interface SvmCollateralEvmErc20DeployedAddresses {
  chains: Record<TestChain, Erc20InventoryChainDeployment>;
  monitoredRoute: Record<TestChain, string>; // EVM: chain -> monitoredRouter address
  bridgeRoute: Record<TestChain, string>; // EVM: chain -> bridgeRouter address
  tokens: Record<TestChain, string>; // EVM: chain -> ERC20 token address
  svm: SvmCollateralDeployedAddresses;
}

// ── Balance presets in USDC units (6 decimals, 1 USDC = 1_000_000) ──
// "10000000000" = 10,000 USDC
// "0" = 0 USDC (deficit)

export const COLLATERAL_BALANCE_PRESETS: Record<
  string,
  {
    evmUsdcBalances: Record<TestChain, string>;
    svmSplEscrowAmount: bigint;
  }
> = {
  // anvil2 in deficit, SVM funded
  COLLATERAL_INVENTORY_EMPTY_DEST: {
    evmUsdcBalances: {
      anvil1: '10000000000',
      anvil2: '0',
      anvil3: '10000000000',
    },
    svmSplEscrowAmount: BigInt('10000000000'),
  },
  // SVM in deficit, all EVM funded
  COLLATERAL_INVENTORY_SVM_DEFICIT: {
    evmUsdcBalances: {
      anvil1: '10000000000',
      anvil2: '10000000000',
      anvil3: '10000000000',
    },
    svmSplEscrowAmount: 0n,
  },
  // All funded (balanced)
  COLLATERAL_INVENTORY_BALANCED: {
    evmUsdcBalances: {
      anvil1: '10000000000',
      anvil2: '10000000000',
      anvil3: '10000000000',
    },
    svmSplEscrowAmount: BigInt('10000000000'),
  },
  // All EVM in deficit, SVM funded
  COLLATERAL_INVENTORY_EVM_ALL_DEFICIT: {
    evmUsdcBalances: {
      anvil1: '0',
      anvil2: '0',
      anvil3: '0',
    },
    svmSplEscrowAmount: BigInt('10000000000'),
  },
  // anvil2 + SVM in deficit
  COLLATERAL_INVENTORY_MIXED_DEFICIT: {
    evmUsdcBalances: {
      anvil1: '10000000000',
      anvil2: '0',
      anvil3: '10000000000',
    },
    svmSplEscrowAmount: 0n,
  },
};

// ── Signer balance presets (EVM ERC20 balances) ──
export const COLLATERAL_SIGNER_PRESETS: Record<
  string,
  Partial<Record<TestChain, string>>
> = {
  COLLATERAL_SIGNER_FUNDED: {
    anvil1: '20000000000',
    anvil2: '20000000000',
    anvil3: '20000000000',
  },
  COLLATERAL_SIGNER_ZERO_ALL: {
    anvil1: '0',
    anvil2: '0',
    anvil3: '0',
  },
  COLLATERAL_SIGNER_PARTIAL_ANVIL2: {
    anvil2: '5000000000',
  },
  COLLATERAL_SIGNER_FUNDED_ANVIL1: {
    anvil1: '20000000000',
    anvil2: '0',
    anvil3: '0',
  },
};

// ── WarpCoreConfig builder for mixed EVM ERC20 + SVM collateral routes ──
export function buildMixedCollateralWarpCoreConfig(
  addresses: SvmCollateralEvmErc20DeployedAddresses,
): WarpCoreConfig {
  const evmTokens = TEST_CHAIN_CONFIGS.map((chain) => ({
    chainName: chain.name,
    standard: TokenStandard.EvmHypCollateral,
    decimals: USDC_DECIMALS,
    symbol: 'USDC',
    name: 'USD Coin',
    addressOrDenom: addresses.monitoredRoute[chain.name],
    collateralAddressOrDenom: addresses.tokens[chain.name],
    connections: [
      // EVM-EVM connections
      ...TEST_CHAIN_CONFIGS.filter((other) => other.name !== chain.name).map(
        (other) => ({
          token: `${ProtocolType.Ethereum}|${other.name}|${addresses.monitoredRoute[other.name]}`,
        }),
      ),
      // EVM-SVM connection
      {
        token: `${ProtocolType.Sealevel}|${SVM_CHAIN_NAME}|${addresses.svm.warpRouter}`,
      },
    ],
  }));

  const svmToken = {
    chainName: SVM_CHAIN_NAME,
    standard: TokenStandard.SealevelHypCollateral,
    decimals: SPL_USDC_DECIMALS,
    symbol: 'USDC',
    name: 'USD Coin',
    addressOrDenom: addresses.svm.warpRouter,
    collateralAddressOrDenom: addresses.svm.splMint,
    connections: TEST_CHAIN_CONFIGS.map((chain) => ({
      token: `${ProtocolType.Ethereum}|${chain.name}|${addresses.monitoredRoute[chain.name]}`,
    })),
  };

  return {
    tokens: [...evmTokens, svmToken],
  };
}

// ── MinAmount strategy config for collateral (USDC amounts, 6 decimals) ──
// "5000" = 5,000 USDC minimum
// "10000" = 10,000 USDC target
export function buildMixedCollateralStrategyConfig(): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: {
        anvil1: {
          minAmount: {
            min: '5000',
            target: '10000',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil2: {
          minAmount: {
            min: '5000',
            target: '10000',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        anvil3: {
          minAmount: {
            min: '5000',
            target: '10000',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
        [SVM_CHAIN_NAME]: {
          minAmount: {
            min: '5000',
            target: '10000',
            type: RebalancerMinAmountType.Absolute,
          },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.LiFi,
        },
      },
    },
  ];
}

// ── Expected amounts (6 decimals) ──
export const COLLATERAL_MIN_AMOUNT_USDC = BigInt('5000000000'); // 5,000 USDC
export const COLLATERAL_TARGET_AMOUNT_USDC = BigInt('10000000000'); // 10,000 USDC
export const COLLATERAL_EXPECTED_DEFICIT_USDC = COLLATERAL_TARGET_AMOUNT_USDC; // deficit when empty

// ── Test chain list including SVM ──
export const ALL_COLLATERAL_CHAINS = [...TEST_CHAINS, SVM_CHAIN_NAME] as const;
export type CollateralChain = (typeof ALL_COLLATERAL_CHAINS)[number];
