import {
  type Address,
  type Blockhash,
  type IInstruction,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import type { SvmInstruction, SvmTransaction } from './types.js';

/**
 * Default compute units for transactions (matching Rust CLI).
 */
export const DEFAULT_COMPUTE_UNITS = 200_000;

/**
 * Default micro lamports per compute unit for priority fees.
 */
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1;

/**
 * System program address for compute budget instructions.
 */
const COMPUTE_BUDGET_PROGRAM_ID =
  'ComputeBudget111111111111111111111111111111' as Address;

/**
 * Creates a SetComputeUnitLimit instruction.
 * Instruction discriminator: 2
 */
function createSetComputeUnitLimitInstruction(
  units: number,
): IInstruction<typeof COMPUTE_BUDGET_PROGRAM_ID> {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true);

  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data,
  };
}

/**
 * Creates a SetComputeUnitPrice instruction.
 * Instruction discriminator: 3
 */
function createSetComputeUnitPriceInstruction(
  microLamports: bigint,
): IInstruction<typeof COMPUTE_BUDGET_PROGRAM_ID> {
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice discriminator
  new DataView(data.buffer).setBigUint64(1, microLamports, true);

  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data,
  };
}

/**
 * Returns compute budget instructions for setting compute unit limit and price.
 *
 * @param units - Number of compute units to request
 * @param microLamports - Priority fee in micro lamports per compute unit (optional)
 */
export function getComputeBudgetInstructions(
  units: number = DEFAULT_COMPUTE_UNITS,
  microLamports?: number,
): SvmInstruction[] {
  const instructions: SvmInstruction[] = [
    createSetComputeUnitLimitInstruction(units),
  ];

  if (microLamports !== undefined && microLamports > 0) {
    instructions.push(
      createSetComputeUnitPriceInstruction(BigInt(microLamports)),
    );
  }

  return instructions;
}

/**
 * Builds a compiled transaction from instructions.
 *
 * @param params - Transaction parameters
 * @param params.instructions - Instructions to include
 * @param params.feePayer - Fee payer signer
 * @param params.recentBlockhash - Recent blockhash for transaction lifetime
 * @param params.computeUnits - Compute units to request (defaults to 200k)
 * @param params.priorityFeeMicroLamports - Optional priority fee
 */
export function buildTransaction(params: {
  instructions: SvmInstruction[];
  feePayer: TransactionSigner;
  recentBlockhash: Blockhash;
  lastValidBlockHeight: bigint;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
}): ReturnType<typeof compileTransaction> {
  const {
    instructions,
    feePayer,
    recentBlockhash,
    lastValidBlockHeight,
    computeUnits = DEFAULT_COMPUTE_UNITS,
    priorityFeeMicroLamports,
  } = params;

  // Add compute budget instructions at the beginning
  const computeBudgetIxs = getComputeBudgetInstructions(
    computeUnits,
    priorityFeeMicroLamports,
  );

  const allInstructions = [...computeBudgetIxs, ...instructions];

  // Build transaction message using the @solana/kit pattern
  const txMessage = createTransactionMessage({ version: 0 });

  // Chain the operations
  const withFeePayer = setTransactionMessageFeePayer(
    feePayer.address,
    txMessage,
  );

  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: recentBlockhash, lastValidBlockHeight },
    withFeePayer,
  );

  const withInstructions = appendTransactionMessageInstructions(
    allInstructions as IInstruction[],
    withLifetime,
  );

  return compileTransaction(withInstructions);
}

/**
 * Converts an SvmTransaction to instructions with compute budget prepended.
 */
export function transactionToInstructions(
  tx: SvmTransaction,
): SvmInstruction[] {
  const computeUnits = tx.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const computeBudgetIxs = getComputeBudgetInstructions(computeUnits);
  return [...computeBudgetIxs, ...tx.instructions];
}
