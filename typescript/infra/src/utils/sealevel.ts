import { TransactionInstruction } from '@solana/web3.js';
import { resolve } from 'path';

import {
  SealevelRemoteGasData,
  SvmMultiprotocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';

import { getMonorepoRoot, readJSONAtPath } from './utils.js';

export const svmGasOracleConfigPath = (environment: DeployEnvironment) =>
  resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/gas-oracle-configs.json`,
  );

// SOLANA_TX_SIZE_LIMIT = 1232 bytes
// batches of 10 fill up about 60% of the limit
export const DEFAULT_MAX_SEALEVEL_BATCH_SIZE = 10;

export async function batchAndSendTransactions<T>(params: {
  /** Chain name for logging */
  chain: string;
  /** Sealevel signer adapter */
  adapter: SvmMultiprotocolSignerAdapter;
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
