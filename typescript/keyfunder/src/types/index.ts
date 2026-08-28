/**
 * TypeScript Interfaces and Types for Keyfunder
 */

import { ProtocolType } from '@hyperlane-xyz/sdk';

export type { ProtocolType };

export type KeyType = 'privateKey' | 'awsKms' | 'keystore' | 'mnemonic';

export enum StrategyType {
  Direct = 'direct',
  WarpRoute = 'warpRoute',
  OpStackBridge = 'opStackBridge',
  ArbitrumInbox = 'arbitrumInbox',
  RollupBridge = 'rollupBridge',
}

export interface FunderConfig {
  type: KeyType;
  key?: string;
  mnemonic?: string;
  kmsKeyId?: string;
  kmsRegion?: string;
  keystorePath?: string;
  password?: string;
  passwordEnv?: string;
  minReserve?: Record<string, string> | string; // per-chain or global min balance floor
}

export interface FundingPolicy {
  minBalance: string; // Balance below which funding triggers (decimal string in native units, e.g. "0.2")
  desiredBalance: string; // Target balance to top up to (decimal string in native units, e.g. "1.0")
  maxFundingAmount?: string; // Cap per single top-up tx (decimal string in native units, e.g. "1.5")
}

export interface RecipientConfig {
  name?: string;
  address: string;
  policy?: string; // Reference to a named policy in policies map
  minBalance?: string; // Inline policy override
  desiredBalance?: string; // Inline policy override
  maxFundingAmount?: string; // Inline policy override
  strategy?: StrategyType;
  tokenAddress?: string; // Optional token address for ERC20/SPL/Cosmos token balance
  tokenDenom?: string; // Optional Cosmos denom
}

export interface StrategyConfig {
  type: StrategyType;
  warpRouteAddress?: string;
  destinationDomain?: number;
  bridgeAddress?: string;
  portalAddress?: string;
  inboxAddress?: string;
  l2GasLimit?: number;
  maxSubmissionCost?: string;
  maxGas?: string;
  gasPriceBid?: string;
  denom?: string; // Cosmos denom (e.g. 'uatom', 'inj')
  [key: string]: unknown;
}

export interface ChainFundingConfig {
  chain?: string;
  protocol: ProtocolType;
  rpcUrl?: string;
  fallbackRpcUrls?: string[];
  funderKey?: FunderConfig;
  funderMinReserve?: string; // Default floor for this chain (e.g. "0.05")
  gasBufferMultiplier?: number; // e.g. 1.2
  strategy?: StrategyType;
  strategyConfig?: StrategyConfig;
  recipients: RecipientConfig[];
  nativeDecimals?: number; // 18 for EVM, 9 for Solana, 6 for Cosmos default
  nativeSymbol?: string; // ETH, SOL, ATOM, etc.
}

export interface KeyfunderConfig {
  globalFunderKey?: FunderConfig;
  funder?: FunderConfig;
  chains: Record<string, ChainFundingConfig>;
  policies?: Record<string, FundingPolicy>;
  strategies?: Record<string, StrategyConfig>;
  cronSchedule?: string;
  daemonIntervalSeconds?: number;
  intervalSec?: number;
  dryRun?: boolean;
  metricsPort?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export type FundingActionStatus = 'PENDING' | 'EXECUTED' | 'SKIPPED' | 'FAILED';

export interface FundingAction {
  chain: string;
  protocol: ProtocolType;
  recipient: string;
  recipientName?: string;
  currentBalance: bigint;
  formattedCurrentBalance: string;
  minThreshold: bigint;
  formattedMinThreshold: string;
  desiredBalance: bigint;
  formattedDesiredBalance: string;
  requiredFunding: bigint;
  formattedRequiredFunding: string;
  funderAddress: string;
  funderBalance: bigint;
  formattedFunderBalance: string;
  strategy: StrategyType;
  status: FundingActionStatus;
  txHash?: string;
  error?: string;
  skipReason?: string;
  decimals: number;
  symbol: string;
  tokenAddress?: string;
  tokenDenom?: string;
}

export interface FundingExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

export interface GasFeeEstimates {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  gasLimit: bigint;
}

export interface ChainBalanceReport {
  chain: string;
  protocol: ProtocolType;
  funderAddress: string;
  funderBalance: bigint;
  formattedFunderBalance: string;
  recipientBalances: Array<{
    recipient: string;
    name?: string;
    balance: bigint;
    formattedBalance: string;
    minBalance: bigint;
    formattedMinBalance: string;
    desiredBalance: bigint;
    formattedDesiredBalance: string;
    needsFunding: boolean;
    deficit: bigint;
    formattedDeficit: string;
  }>;
}

export interface StrategyExecutionContext {
  chainConfig: ChainFundingConfig;
  funderConfig: FunderConfig;
  strategyConfig?: StrategyConfig;
  dryRun?: boolean;
  rpcUrl?: string;
}
