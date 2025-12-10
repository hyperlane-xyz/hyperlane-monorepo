import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';
import chalk from 'chalk';
import path, { resolve } from 'path';

import {
  ChainMap,
  ChainName,
  IsmType,
  MultiProtocolProvider,
  MultisigIsmConfig,
  SealevelDomainData,
  SealevelDomainDataSchema,
  SealevelInstructionWrapper,
  SealevelMultisigAdapter,
  SealevelMultisigIsmSetValidatorsInstruction,
  SealevelMultisigIsmSetValidatorsInstructionSchema,
  SealevelRemoteGasData,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { SealevelMultisigIsmInstructionType as SdkMultisigIsmInstructionType } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';

import { getValidatorAlias } from './consts.js';
import { getMonorepoRoot } from './utils.js';

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
 * Solana compute budget constants
 * From solana_program_runtime::compute_budget
 * See: rust/sealevel/client/src/main.rs
 */
export const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT = 200_000;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const MAX_HEAP_FRAME_BYTES = 256 * 1024; // 262,144 bytes

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
  type: typeof IsmType.MESSAGE_ID_MULTISIG;
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
    return readJson(programIdsPath);
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
export function formatRemoteGasData(data: SealevelRemoteGasData): string {
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

/**
 * MultisigIsm Utility Functions
 */

/**
 * Type for MultisigIsm on-chain state
 */
export interface MultisigIsmOnChainState {
  domain: number;
  validators: string[]; // Hex strings (0x-prefixed)
  threshold: number;
}

/**
 * Fetch on-chain MultisigIsm state for a specific domain
 * @param connection - Solana connection
 * @param multisigIsmProgramId - MultisigIsm program ID
 * @param domain - Remote domain to fetch config for
 * @returns On-chain validator config or null if not set
 */
export async function fetchMultisigIsmState(
  connection: Connection,
  multisigIsmProgramId: PublicKey,
  domain: number,
): Promise<MultisigIsmOnChainState | null> {
  // Derive the domain data PDA
  const domainDataPda = SealevelMultisigAdapter.deriveDomainDataPda(
    multisigIsmProgramId,
    domain,
  );

  // Fetch the account
  const accountInfo = await connection.getAccountInfo(domainDataPda);
  if (!accountInfo || !accountInfo.data) {
    rootLogger.debug(
      `Domain ${domain} PDA ${domainDataPda.toBase58()} does not exist on-chain`,
    );
    return null;
  }

  rootLogger.debug(
    `Domain ${domain} PDA ${domainDataPda.toBase58()} found, data length: ${accountInfo.data.length} bytes`,
  );

  // Deserialize using Borsh
  // The on-chain AccountData wrapper adds a 1-byte `initialized` boolean flag before the actual data
  // See: rust/sealevel/libraries/account-utils/src/lib.rs AccountData::fetch_data()
  try {
    // Skip the first byte (initialized flag)
    const initialized = accountInfo.data[0] === 1;
    if (!initialized) {
      rootLogger.debug(
        `Domain ${domain} PDA exists but is not initialized (initialized flag = ${accountInfo.data[0]})`,
      );
      return null;
    }

    // Deserialize the SealevelDomainData struct starting from byte 1
    const domainData = deserializeUnchecked(
      SealevelDomainDataSchema,
      SealevelDomainData,
      accountInfo.data.slice(1),
    ) as SealevelDomainData;

    rootLogger.debug(
      `Domain ${domain} deserialized: ${domainData.validatorsAndThreshold.validators.length} validators, threshold ${domainData.validatorsAndThreshold.threshold}`,
    );

    return {
      domain,
      validators: domainData.validatorsAndThreshold.validatorAddresses,
      threshold: domainData.validatorsAndThreshold.threshold,
    };
  } catch (error) {
    // Log deserialization errors with account data for debugging
    rootLogger.info(
      `Failed to deserialize domain ${domain} (PDA: ${domainDataPda.toBase58()}): ${error}`,
    );
    rootLogger.info(
      `Account data (hex): ${accountInfo.data.toString('hex').slice(0, 200)}...`,
    );
    // Return null if deserialization fails (account may be uninitialized or corrupted)
    return null;
  }
}

/**
 * Compare desired vs actual MultisigIsm configs
 * @param expected - Desired config from print-multisig-ism-config
 * @param actual - On-chain config (or undefined if not set)
 * @returns true if configs match
 */
export function diffMultisigIsmConfigs(
  expected: SvmMultisigConfig,
  actual?: SvmMultisigConfig,
): boolean {
  // If account doesn't exist, it matches only if we expect no validators
  if (!actual) {
    return expected.validators.length === 0;
  }

  // Account exists - compare validators and threshold
  // Compare validators (need to normalize hex format)
  const actualValidatorsSet = new Set(
    actual.validators.map((v) => v.toLowerCase()),
  );
  const expectedValidatorsSet = new Set(
    expected.validators.map((v) => v.toLowerCase()),
  );

  if (actualValidatorsSet.size !== expectedValidatorsSet.size) {
    return false;
  }

  for (const validator of actualValidatorsSet) {
    if (!expectedValidatorsSet.has(validator)) {
      return false;
    }
  }

  // Compare threshold
  return actual.threshold === expected.threshold;
}

/**
 * Serialize MultisigIsm difference for display with color coding and validator aliases
 * @param remoteChainName - Remote chain name for looking up validator aliases
 * @param expected - Desired config
 * @param actual - On-chain config (or undefined if not set)
 * @returns Formatted difference string
 */
export function serializeMultisigIsmDifference(
  remoteChainName: ChainName,
  expected: SvmMultisigConfig,
  actual?: SvmMultisigConfig,
): string {
  if (!actual) {
    return chalk.green(
      `NEW: ${expected.validators.length} validators, threshold ${expected.threshold}`,
    );
  }

  const parts: string[] = [];

  // Compare validators
  const actualValidatorsSet = new Set(
    actual.validators.map((v) => v.toLowerCase()),
  );
  const expectedValidatorsSet = new Set(
    expected.validators.map((v) => v.toLowerCase()),
  );

  const added = [...expectedValidatorsSet].filter(
    (v) => !actualValidatorsSet.has(v),
  );
  const removed = [...actualValidatorsSet].filter(
    (v) => !expectedValidatorsSet.has(v),
  );

  if (added.length > 0) {
    const addedAliases = added.map((addr) =>
      getValidatorAlias(remoteChainName, addr),
    );
    parts.push(
      chalk.green(`+${added.length} validators: ${addedAliases.join(', ')}`),
    );
  }

  if (removed.length > 0) {
    const removedAliases = removed.map((addr) =>
      getValidatorAlias(remoteChainName, addr),
    );
    parts.push(
      chalk.red(`-${removed.length} validators: ${removedAliases.join(', ')}`),
    );
  }

  // Compare threshold
  if (actual.threshold !== expected.threshold) {
    parts.push(
      chalk.yellow(`Threshold: ${actual.threshold} → ${expected.threshold}`),
    );
  }

  return parts.length > 0 ? parts.join(', ') : chalk.gray('No changes');
}

// ============================================================================
// Compute Budget Helpers
// ============================================================================

/**
 * Determine if a chain needs explicit compute budget instructions in vault transactions
 *
 * Solana mainnet's Squads UI handles compute budget automatically during execution.
 * Alt-SVM chains need explicit compute budget in the vault transaction itself.
 *
 * @param chain - Chain name
 * @returns true if compute budget instructions should be added to the transaction
 */
export function shouldAddComputeBudgetInstructions(chain: ChainName): boolean {
  // Solana mainnet Squads UI handles compute budget automatically
  // Alt-SVM Squads UIs need explicit compute budget (matching Rust CLI)
  return chain !== 'solanamainnet';
}

/**
 * Build standard compute budget instructions for SVM transactions
 *
 * Creates instructions for:
 * - Request heap frame (256KB)
 * - Set compute unit limit (1.4M CU - transaction maximum)
 *
 * See: rust/sealevel/client/src/main.rs
 *
 * @returns Array of compute budget instructions
 */
export function buildComputeBudgetInstructions(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.requestHeapFrame({ bytes: MAX_HEAP_FRAME_BYTES }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
  ];
}

/**
 * Check if a transaction instruction is a compute budget instruction
 *
 * @param instruction - Transaction instruction to check
 * @returns true if the instruction targets the ComputeBudget program
 */
export function isComputeBudgetInstruction(
  instruction: TransactionInstruction,
): boolean {
  return instruction.programId.equals(ComputeBudgetProgram.programId);
}

// ============================================================================
// MultisigIsm Instruction Building
// ============================================================================

/**
 * Build MultisigIsm SetValidatorsAndThreshold instructions
 * @param chain - Chain name (to determine if compute budget is needed)
 * @param multisigIsmProgramId - MultisigIsm program ID
 * @param owner - Owner public key (signer)
 * @param configs - Map of chain name -> config
 * @param mpp - MultiProtocolProvider for chain metadata lookups
 * @returns Array of transaction instructions
 */
export function buildMultisigIsmInstructions(
  chain: ChainName,
  multisigIsmProgramId: PublicKey,
  owner: PublicKey,
  configs: SvmMultisigConfigMap,
  mpp: MultiProtocolProvider,
): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];

  // Add compute budget instructions if needed for this chain
  if (shouldAddComputeBudgetInstructions(chain)) {
    instructions.push(...buildComputeBudgetInstructions());
  }

  // Derive the access control PDA (same for all instructions)
  const accessControlPda =
    SealevelMultisigAdapter.deriveAccessControlPda(multisigIsmProgramId);

  // Sort chain names alphabetically for deterministic ordering
  const sortedChainNames = Object.keys(configs).sort();

  for (const remoteChainName of sortedChainNames) {
    const config = configs[remoteChainName];
    const remoteMeta = mpp.getChainMetadata(remoteChainName);
    const domain = remoteMeta.domainId;

    // Derive the domain data PDA
    const domainDataPda = SealevelMultisigAdapter.deriveDomainDataPda(
      multisigIsmProgramId,
      domain,
    );

    // Convert hex validators to Uint8Array
    const validators = SealevelMultisigAdapter.hexValidatorsToUint8Array(
      config.validators,
    );

    // Validate validators
    validators.forEach((validator, index) => {
      if (validator.length !== 20) {
        throw new Error(
          `Validator at index ${index} must be 20 bytes, got ${validator.length}`,
        );
      }
    });

    // Build instruction following Rust account order
    const keys: AccountMeta[] = [
      // 0. `[signer]` The access control owner and payer of the domain PDA.
      { pubkey: owner, isSigner: true, isWritable: true },
      // 1. `[]` The access control PDA account.
      { pubkey: accessControlPda, isSigner: false, isWritable: false },
      // 2. `[writable]` The PDA relating to the provided domain.
      { pubkey: domainDataPda, isSigner: false, isWritable: true },
      // 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const value = new SealevelInstructionWrapper({
      instruction: SdkMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD,
      data: new SealevelMultisigIsmSetValidatorsInstruction({
        domain,
        validators,
        threshold: config.threshold,
      }),
    });

    const serializedData = serialize(
      SealevelMultisigIsmSetValidatorsInstructionSchema,
      value,
    );

    // Prepend 8-byte program discriminator (required by Rust program)
    // See: rust/sealevel/libraries/account-utils/src/discriminator.rs
    const data = Buffer.concat([
      Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]), // PROGRAM_INSTRUCTION_DISCRIMINATOR
      Buffer.from(serializedData),
    ]);

    const instruction = new TransactionInstruction({
      keys,
      programId: multisigIsmProgramId,
      data,
    });

    instructions.push(instruction);
  }

  return instructions;
}
