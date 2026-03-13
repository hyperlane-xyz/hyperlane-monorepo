import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BigNumber } from 'ethers';

import { SvmSigner, createRpc } from '@hyperlane-xyz/svm-sdk';

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

// ── Mixed balance presets (EVM + SVM) ──
export const MIXED_BALANCE_PRESETS: Record<
  string,
  { evmBalances: Record<string, string>; svmLamports: number }
> = {
  INVENTORY_EMPTY_DEST: {
    evmBalances: {
      anvil1: '5000000000000000000', // 5 ETH
      anvil2: '0',
      anvil3: '5000000000000000000', // 5 ETH
    },
    svmLamports: SVM_FUND_AMOUNT_LAMPORTS,
  },
  INVENTORY_MULTI_DEFICIT: {
    evmBalances: {
      anvil1: '5000000000000000000', // 5 ETH
      anvil2: '0',
      anvil3: '0',
    },
    svmLamports: SVM_DEFICIT_FUND_AMOUNT_LAMPORTS,
  },
  INVENTORY_SVM_DEFICIT: {
    evmBalances: {
      anvil1: '5000000000000000000', // 5 ETH
      anvil2: '5000000000000000000', // 5 ETH
      anvil3: '5000000000000000000', // 5 ETH
    },
    svmLamports: SVM_DEFICIT_FUND_AMOUNT_LAMPORTS,
  },
  INVENTORY_BALANCED: {
    evmBalances: {
      anvil1: '5000000000000000000', // 5 ETH
      anvil2: '5000000000000000000', // 5 ETH
      anvil3: '5000000000000000000', // 5 ETH
    },
    svmLamports: SVM_FUND_AMOUNT_LAMPORTS,
  },
};

// ── Mixed signer balance presets (ETH balances for signer wallet) ──
export const MIXED_SIGNER_PRESETS: Record<
  string,
  Partial<Record<string, string>>
> = {
  SIGNER_PARTIAL_ANVIL2: {
    anvil2: '1000000000000000000', // 1 ETH
  },
  SIGNER_LOW_ALL: {
    anvil1: '1000000000000000000', // 1 ETH
    anvil2: '1000000000000000000', // 1 ETH
    anvil3: '1000000000000000000', // 1 ETH
  },
  SIGNER_FUNDED_ANVIL1: {
    anvil1: '20000000000000000000', // 20 ETH
    anvil2: '0',
    anvil3: '0',
  },
  SIGNER_SPLIT_SOURCES: {
    anvil1: '10000000000000000000', // 10 ETH
    anvil2: '0',
    anvil3: '10000000000000000000', // 10 ETH
  },
};

// ── Mixed min/target amount constants ──
export const MIXED_MIN_AMOUNT_TARGET_WEI = BigNumber.from(
  '2000000000000000000',
); // 2 ETH
export const MIXED_MIN_AMOUNT_TARGET_LAMPORTS = 2 * 1_000_000_000; // 2 SOL

// ── Mixed balance preset builder (backward compat) ──
export function buildMixedBalancePreset(
  scenario: 'evm-deficit' | 'svm-deficit',
): { evmBalances: Record<string, string>; svmLamports: number } {
  if (scenario === 'evm-deficit') {
    return MIXED_BALANCE_PRESETS.INVENTORY_EMPTY_DEST;
  } else {
    return MIXED_BALANCE_PRESETS.INVENTORY_SVM_DEFICIT;
  }
}

// ── svm-sdk helpers for warp route deployment ──

/**
 * Creates an SvmSigner from the local-e2e deployer keypair file.
 * The keypair JSON is a 64-byte array (Solana format).
 */
export async function createSvmSigner(): Promise<SvmSigner> {
  const keypairBytes: number[] = JSON.parse(
    fs.readFileSync(DEPLOYER_KEYPAIR, 'utf8'),
  );
  const privateKeyHex = Buffer.from(keypairBytes).toString('hex');
  return SvmSigner.connectWithSigner([SVM_RPC_URL], privateKeyHex);
}

/**
 * Creates an SvmRpc client pointing at the local solana-test-validator.
 */
export function createSvmRpc() {
  return createRpc(SVM_RPC_URL);
}
