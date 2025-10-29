import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import path, { resolve } from 'path';

import {
  ChainMap,
  ChainName,
  IsmType,
  MultisigIsmConfig,
  SealevelRemoteGasData,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';

import { getMonorepoRoot, readJSONAtPath } from './utils.js';

// ============================================================================
// Solana Data Structure Sizes
// ============================================================================

/**
 * Size of a Solana PublicKey in bytes
 */
export const SOLANA_PUBKEY_SIZE = 32;

/**
 * Size of a Solana u32 in bytes
 */
export const SOLANA_U32_SIZE = 4;

/**
 * Size of a Solana u8 in bytes
 */
export const SOLANA_U8_SIZE = 1;

/**
 * Size of a Solana u16 in bytes
 */
export const SOLANA_U16_SIZE = 2;

/**
 * Size of an Ethereum address (H160) in bytes
 * Used for validator addresses in Hyperlane MultisigIsm
 */
export const ETHEREUM_ADDRESS_SIZE = 20;

/**
 * Discriminator value for Option::Some in Rust/Anchor
 */
export const OPTION_SOME_DISCRIMINATOR = 1;

/**
 * Discriminator value for Option::None in Rust/Anchor
 */
export const OPTION_NONE_DISCRIMINATOR = 0;

// ============================================================================
// Hyperlane Program Discriminator Lengths
// ============================================================================

/**
 * Mailbox instruction discriminator size (4 byte Borsh u32 enum discriminator)
 */
export const MAILBOX_DISCRIMINATOR_SIZE = 4;

/**
 * Hyperlane Sealevel program instruction discriminator size
 * (8-byte Anchor discriminator)
 */
export const HYPERLANE_PROGRAM_DISCRIMINATOR_SIZE = 8;

/**
 * Maximum number of validators in MultisigIsm
 * Must match Solidity: uint8 constant MAX_VALIDATORS = 20 in MultisigIsm.t.sol
 */
export const MAX_VALIDATORS = 20;

// ============================================================================
// Solana System Limits
// ============================================================================

/**
 * Maximum number of account keys in a Solana transaction
 */
export const MAX_SOLANA_ACCOUNTS = 256;

/**
 * Maximum reasonable Solana account size (10KB)
 * Accounts larger than this are suspicious
 */
export const MAX_SOLANA_ACCOUNT_SIZE = 10240;

/**
 * First real instruction index in Solana transactions
 * (index 0 is typically a dummy instruction)
 */
export const FIRST_REAL_INSTRUCTION_INDEX = 1;

// ============================================================================
// Well-Known Solana Program IDs
// ============================================================================

/**
 * Solana System Program ID
 */
export const SYSTEM_PROGRAM_ID = new PublicKey(
  '11111111111111111111111111111111',
);

/**
 * Solana Compute Budget Program ID
 */
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111',
);

// ============================================================================
// Program Names (for transaction parsing/display)
// ============================================================================

/**
 * Program name enum for consistent labeling
 */
export enum ProgramName {
  MAILBOX = 'Mailbox',
  MULTISIG_ISM = 'MultisigIsmMessageId',
  SQUADS_V4 = 'SquadsV4',
  SYSTEM_PROGRAM = 'System Program',
  COMPUTE_BUDGET = 'Compute Budget Program',
  UNKNOWN = 'Unknown',
}

// ============================================================================
// Instruction Type Labels (for transaction parsing/display)
// ============================================================================

/**
 * Instruction type enum for consistent labeling
 */
export enum InstructionType {
  UNKNOWN = 'Unknown',
  SYSTEM_CALL = 'System Program Call',
  COMPUTE_BUDGET = 'Compute Budget',
  PARSE_FAILED = 'Failed to Parse',
}

// ============================================================================
// Mailbox Instruction Types
// ============================================================================

/**
 * Mailbox instruction discriminator values
 * Matches rust/sealevel/programs/mailbox/src/instruction.rs
 * Borsh enum serialization uses u32 discriminators
 */
export enum MailboxInstructionType {
  INIT = 0,
  INBOX_PROCESS = 1,
  INBOX_SET_DEFAULT_ISM = 2,
  INBOX_GET_RECIPIENT_ISM = 3,
  OUTBOX_DISPATCH = 4,
  OUTBOX_GET_COUNT = 5,
  OUTBOX_GET_LATEST_CHECKPOINT = 6,
  OUTBOX_GET_ROOT = 7,
  GET_OWNER = 8,
  TRANSFER_OWNERSHIP = 9,
  CLAIM_PROTOCOL_FEES = 10,
  SET_PROTOCOL_FEE_CONFIG = 11,
}

/**
 * Human-readable names for Mailbox instructions
 */
export const MailboxInstructionName: Record<MailboxInstructionType, string> = {
  [MailboxInstructionType.INIT]: 'Init',
  [MailboxInstructionType.INBOX_PROCESS]: 'InboxProcess',
  [MailboxInstructionType.INBOX_SET_DEFAULT_ISM]: 'InboxSetDefaultIsm',
  [MailboxInstructionType.INBOX_GET_RECIPIENT_ISM]: 'InboxGetRecipientIsm',
  [MailboxInstructionType.OUTBOX_DISPATCH]: 'OutboxDispatch',
  [MailboxInstructionType.OUTBOX_GET_COUNT]: 'OutboxGetCount',
  [MailboxInstructionType.OUTBOX_GET_LATEST_CHECKPOINT]:
    'OutboxGetLatestCheckpoint',
  [MailboxInstructionType.OUTBOX_GET_ROOT]: 'OutboxGetRoot',
  [MailboxInstructionType.GET_OWNER]: 'GetOwner',
  [MailboxInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
  [MailboxInstructionType.CLAIM_PROTOCOL_FEES]: 'ClaimProtocolFees',
  [MailboxInstructionType.SET_PROTOCOL_FEE_CONFIG]: 'SetProtocolFeeConfig',
};

// ============================================================================
// MultisigIsm Instruction Types
// ============================================================================

/**
 * MultisigIsm instruction discriminator values
 * Matches rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 */
export enum MultisigIsmInstructionType {
  INIT = 0,
  SET_VALIDATORS_AND_THRESHOLD = 1,
  GET_OWNER = 2,
  TRANSFER_OWNERSHIP = 3,
}

/**
 * Human-readable names for MultisigIsm instructions
 */
export const MultisigIsmInstructionName: Record<
  MultisigIsmInstructionType,
  string
> = {
  [MultisigIsmInstructionType.INIT]: 'Init',
  [MultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD]:
    'SetValidatorsAndThreshold',
  [MultisigIsmInstructionType.GET_OWNER]: 'GetOwner',
  [MultisigIsmInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
};

// ============================================================================
// Error and Warning Messages (for transaction parsing)
// ============================================================================

/**
 * Error message enum for instruction parsing
 */
export enum ErrorMessage {
  INVALID_INSTRUCTION_LENGTH = 'Invalid instruction data length',
  INSTRUCTION_TOO_SHORT = 'Instruction data too short',
  INVALID_MULTISIG_ISM_DATA = 'Invalid MultisigIsm instruction data',
  INVALID_SQUADS_DATA = 'Invalid Squads instruction data',
}

/**
 * Warning message enum for security and parsing issues
 */
export enum WarningMessage {
  OWNERSHIP_TRANSFER = '⚠️  OWNERSHIP TRANSFER DETECTED',
  OWNERSHIP_RENUNCIATION = '⚠️  OWNERSHIP RENUNCIATION DETECTED',
  UNKNOWN_SQUADS_INSTRUCTION = 'Unknown Squads instruction',
}

/**
 * Format warning message for unknown program
 */
export function formatUnknownProgramWarning(programId: string): string {
  return `⚠️  UNKNOWN PROGRAM: ${programId}`;
}

/**
 * Format warning message for unknown instruction
 */
export function formatUnknownInstructionWarning(
  programType: string,
  discriminator: number,
): string {
  return `Unknown ${programType} instruction: ${discriminator}`;
}

export const svmGasOracleConfigPath = (environment: DeployEnvironment) =>
  resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/gas-oracle-configs.json`,
  );

export const multisigIsmConfigPath = (
  environment: DeployEnvironment,
  context: Contexts,
  local: ChainName,
) =>
  path.resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/multisig-ism-message-id/${local}/${context}/multisig-config.json`,
  );

/**
 * All multisig ISM configurations for a chain, keyed by remote chain name,
 * restricted to config type MESSAGE_ID_MULTISIG
 */
export type SvmMultisigConfig = Omit<MultisigIsmConfig, 'type'> & {
  type: IsmType.MESSAGE_ID_MULTISIG;
};
export type SvmMultisigConfigMap = ChainMap<SvmMultisigConfig>;

// SOLANA_TX_SIZE_LIMIT = 1232 bytes
// batches of 10 fill up about 60% of the limit
export const DEFAULT_MAX_SEALEVEL_BATCH_SIZE = 10;

export async function batchAndSendTransactions<T>(params: {
  /** Chain name for logging */
  chain: string;
  /** Sealevel signer adapter */
  adapter: SvmMultiProtocolSignerAdapter;
  /** Description of operation for logging */
  operationName: string;
  /** Items to process in batches */
  items: T[];
  /** Function to create instruction from batch of items */
  createInstruction: (batch: T[]) => TransactionInstruction;
  /** Function to format batch for logging */
  formatBatch: (batch: T[]) => string;
  /** Maximum items per transaction (default 10) */
  maxBatchSize?: number;
  /** Whether to perform a dry run without sending transactions */
  dryRun?: boolean;
}): Promise<void> {
  const {
    chain,
    adapter,
    operationName,
    items,
    createInstruction,
    formatBatch,
    maxBatchSize = DEFAULT_MAX_SEALEVEL_BATCH_SIZE,
    dryRun = false,
  } = params;
  rootLogger.info(
    `[${chain}] ${dryRun ? 'Would send' : 'Sending'} ${items.length} ${operationName} in batches of ${maxBatchSize}`,
  );

  for (let i = 0; i < items.length; i += maxBatchSize) {
    const batch = items.slice(i, i + maxBatchSize);
    const instruction = createInstruction(batch);

    const batchNum = Math.floor(i / maxBatchSize) + 1;
    const totalBatches = Math.ceil(items.length / maxBatchSize);

    if (dryRun) {
      rootLogger.info(
        `[${chain}] Batch ${batchNum}/${totalBatches}: Would send ${operationName} for ${batch.length} items: ${formatBatch(batch)}`,
      );
    } else {
      const tx = await adapter.buildAndSendTransaction([instruction]);

      rootLogger.info(
        `[${chain}] Batch ${batchNum}/${totalBatches}: ${operationName} ${batch.length} items [${formatBatch(batch)}] - tx: ${tx}`,
      );
    }
  }
}

/**
 * Load core program IDs from environment configuration
 */
export interface CoreProgramIds {
  mailbox: string;
  validator_announce: string;
  multisig_ism_message_id: string;
  igp_program_id: string;
  overhead_igp_account: string;
  igp_account: string;
}

export function loadCoreProgramIds(
  environment: string,
  chain: string,
): CoreProgramIds {
  const programIdsPath = resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/${chain}/core/program-ids.json`,
  );

  try {
    return readJSONAtPath(programIdsPath);
  } catch (error) {
    throw new Error(`Failed to load program IDs from ${programIdsPath}.`);
  }
}

/**
 * Calculate percentage difference between two bigints
 */
export function calculatePercentDifference(
  actual: bigint | number,
  expected: bigint | number,
): string {
  // Convert to bigints if needed
  const actualBigInt = typeof actual === 'bigint' ? actual : BigInt(actual);
  const expectedBigInt =
    typeof expected === 'bigint' ? expected : BigInt(expected);

  if (actualBigInt === 0n) {
    return 'new';
  }
  // Calculate (expected - actual) / actual * 100
  const diff = ((expectedBigInt - actualBigInt) * 10000n) / actualBigInt; // multiply by 10000 for 2 decimal places
  const percentStr = (Number(diff) / 100).toFixed(2);
  return diff >= 0n ? `+${percentStr}%` : `${percentStr}%`;
}

/**
 * Gas Oracle Utility Functions
 */

/**
 * Format RemoteGasData for display
 */
export function formatRemoteGasData(data: any): string {
  // Scale exchange rate by 1e19 (TOKEN_EXCHANGE_RATE_SCALE for Sealevel)
  const exchangeRate = Number(data.token_exchange_rate) / 1e19;
  // Convert gas price to lamports (assuming it's in smallest unit)
  const gasPriceLamports = Number(data.gas_price);

  return `Exchange rate: ${exchangeRate.toFixed(10)}, Gas price: ${gasPriceLamports.toLocaleString()}, Decimals: ${data.token_decimals}`;
}

/**
 * Serialize the difference between actual and expected gas oracle configs
 *
 * NOTE: The token_decimals field should represent the REMOTE chain's decimals, not the local chain's.
 * If you see huge percentage differences, it may be because the on-chain config was incorrectly set with
 * local decimals instead of remote decimals (e.g., solaxy has 6 decimals locally, but ethereum has 18).
 */
export function serializeGasOracleDifference(
  actual: SealevelRemoteGasData,
  expected: SealevelRemoteGasData,
): string {
  const exchangeRateDiff = calculatePercentDifference(
    actual.token_exchange_rate,
    expected.token_exchange_rate,
  );
  const gasPriceDiff = calculatePercentDifference(
    actual.gas_price,
    expected.gas_price,
  );

  // Calculate product diff (exchange rate * gas price)
  const actualProduct =
    BigInt(actual.token_exchange_rate) * BigInt(actual.gas_price);
  const expectedProduct =
    BigInt(expected.token_exchange_rate) * BigInt(expected.gas_price);
  const productDiff = calculatePercentDifference(
    actualProduct,
    expectedProduct,
  );

  const exchangeRate = Number(expected.token_exchange_rate) / 1e19;
  const gasPriceLamports = Number(expected.gas_price);

  return `Exchange rate: ${exchangeRate.toFixed(10)} (${exchangeRateDiff}), Gas price: ${gasPriceLamports.toLocaleString()} (${gasPriceDiff}), Product diff: ${productDiff}`;
}
