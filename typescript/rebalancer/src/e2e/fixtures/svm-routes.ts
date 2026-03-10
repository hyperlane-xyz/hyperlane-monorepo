import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChainMetadata,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { NativeDeployedAddresses, TEST_CHAIN_CONFIGS } from './routes.js';

// ── Path constants ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../../');

export const SO_DIR = path.join(REPO_ROOT, 'rust/main/target/dist');
export const SEALEVEL_DIR = path.join(REPO_ROOT, 'rust/sealevel');
export const AGAVE_BIN_DIR = path.join(
  REPO_ROOT,
  '.local-tools/agave-v3.0.14/bin',
);
export const SEALEVEL_CLIENT = path.join(
  SEALEVEL_DIR,
  'target/debug/hyperlane-sealevel-client',
);
export const DEPLOYER_KEYPAIR = path.join(
  SEALEVEL_DIR,
  'environments/local-e2e/accounts/test_deployer-keypair.json',
);
export const DEPLOYER_ACCOUNT = path.join(
  SEALEVEL_DIR,
  'environments/local-e2e/accounts/test_deployer-account.json',
);
export const GAS_ORACLE_CONFIG = path.join(
  SEALEVEL_DIR,
  'environments/local-e2e/gas-oracle-configs.json',
);
export const MOCK_REGISTRY = 'environments/local-e2e/mock-registry';

// ── SVM chain constants ──
export const SVM_CHAIN_NAME = 'sealeveltest1';
export const SVM_DOMAIN_ID = 13375;
export const SVM_CHAIN_ID = 13375;
export const SVM_RPC_PORT = 8899;
export const SVM_RPC_URL = 'http://127.0.0.1:8899';

// ── Well-known program IDs ──
export const WARP_ROUTE_PROGRAM_ID =
  'CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga';
export const MAILBOX_PROGRAM_ID =
  '692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1';

// ── Warp route identifiers ──
export const SVM_NATIVE_MONITORED_ROUTE_ID = 'SOL/test-svm-native-monitored';

// ── SVM chain metadata ──
export const SVM_CHAIN_METADATA: ChainMetadata = {
  name: SVM_CHAIN_NAME,
  chainId: SVM_CHAIN_ID,
  domainId: SVM_DOMAIN_ID,
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: SVM_RPC_URL }],
  nativeToken: {
    name: 'Solana',
    symbol: 'SOL',
    decimals: 9,
  },
  isTestnet: true,
};

// ── Deployed contract addresses ──
export interface SvmDeployedAddresses {
  mailbox: string;
  ism: string;
  warpToken: string;
  warpTokenAta: string;
}

// ── Mixed SVM/EVM warp core config builder ──
export function buildMixedSvmEvmWarpCoreConfig(
  evmAddresses: NativeDeployedAddresses,
  svmAddresses: SvmDeployedAddresses,
  evmChainNames: string[],
): WarpCoreConfig {
  // Build the full set of chain names (EVM + SVM)
  const allChainNames = [...evmChainNames, SVM_CHAIN_NAME];

  // EVM token entries (HypNative, 18 decimals, ETH)
  const evmTokens = evmChainNames.map((chainName) => {
    const chainConfig = TEST_CHAIN_CONFIGS.find((c) => c.name === chainName);
    if (!chainConfig) {
      throw new Error(`Unknown EVM chain: ${chainName}`);
    }
    const routerAddress =
      evmAddresses.monitoredRoute[
        chainName as keyof typeof evmAddresses.monitoredRoute
      ];
    if (!routerAddress) {
      throw new Error(
        `Missing monitored route address for chain: ${chainName}`,
      );
    }
    return {
      chainName,
      standard: TokenStandard.EvmHypNative,
      decimals: 18,
      symbol: 'ETH',
      name: 'Ether',
      addressOrDenom: routerAddress,
      connections: allChainNames
        .filter((other) => other !== chainName)
        .map((other) => {
          if (other === SVM_CHAIN_NAME) {
            return {
              token: `${ProtocolType.Sealevel}|${SVM_CHAIN_NAME}|${svmAddresses.warpToken}`,
            };
          }
          const otherRouter =
            evmAddresses.monitoredRoute[
              other as keyof typeof evmAddresses.monitoredRoute
            ];
          return {
            token: `${ProtocolType.Ethereum}|${other}|${otherRouter}`,
          };
        }),
    };
  });

  // SVM token entry (SealevelHypNative, 9 decimals, SOL)
  const svmToken = {
    chainName: SVM_CHAIN_NAME,
    standard: TokenStandard.SealevelHypNative,
    decimals: 9,
    symbol: 'SOL',
    name: 'Solana',
    addressOrDenom: svmAddresses.warpToken,
    connections: evmChainNames.map((chainName) => {
      const routerAddress =
        evmAddresses.monitoredRoute[
          chainName as keyof typeof evmAddresses.monitoredRoute
        ];
      return {
        token: `${ProtocolType.Ethereum}|${chainName}|${routerAddress}`,
      };
    }),
  };

  return {
    tokens: [...evmTokens, svmToken],
  };
}

// ── SVM fund amount constants ──
export const SVM_FUND_AMOUNT_LAMPORTS = 10 * 1_000_000_000; // 10 SOL
export const SVM_DEFICIT_FUND_AMOUNT_LAMPORTS = 0;
export const SVM_SURPLUS_FUND_AMOUNT_LAMPORTS = 5 * 1_000_000_000; // 5 SOL

// ── Mixed balance preset builder ──
export function buildMixedBalancePreset(
  scenario: 'evm-deficit' | 'svm-deficit',
): { evmBalances: Record<string, string>; svmLamports: number } {
  if (scenario === 'evm-deficit') {
    // anvil1 is deficit (0 ETH), others surplus (5 ETH), SVM surplus (10 SOL)
    return {
      evmBalances: {
        anvil1: '0x0',
        anvil2: '0x4563918244F40000', // 5 ETH in hex
        anvil3: '0x4563918244F40000', // 5 ETH in hex
      },
      svmLamports: SVM_FUND_AMOUNT_LAMPORTS,
    };
  } else {
    // SVM is deficit (0 SOL), EVM chains surplus (5 ETH each)
    return {
      evmBalances: {
        anvil1: '0x4563918244F40000', // 5 ETH in hex
        anvil2: '0x4563918244F40000', // 5 ETH in hex
        anvil3: '0x4563918244F40000', // 5 ETH in hex
      },
      svmLamports: SVM_DEFICIT_FUND_AMOUNT_LAMPORTS,
    };
  }
}
