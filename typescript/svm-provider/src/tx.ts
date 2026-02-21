import {
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import type { SvmInstruction, SvmTransaction } from './types.js';

export const DEFAULT_COMPUTE_UNITS = 400_000;
export const DEFAULT_WRITE_CHUNK_SIZE = 880;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1;

// FIXME use official client for ComputeBudget program in @solana-program/compute-budget
const COMPUTE_BUDGET_PROGRAM_ID =
  'ComputeBudget111111111111111111111111111111' as Address;

function createSetComputeUnitLimitInstruction(
  units: number,
): Instruction<typeof COMPUTE_BUDGET_PROGRAM_ID> {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
}

function createSetComputeUnitPriceInstruction(
  microLamports: bigint,
): Instruction<typeof COMPUTE_BUDGET_PROGRAM_ID> {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
}

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

export function buildTransactionMessage(params: {
  instructions: SvmInstruction[];
  feePayer: TransactionSigner;
  recentBlockhash: Blockhash;
  lastValidBlockHeight: bigint;
  computeUnits?: number;
  priorityFeeMicroLamports?: number;
}) {
  const {
    instructions,
    feePayer,
    recentBlockhash,
    lastValidBlockHeight,
    computeUnits = DEFAULT_COMPUTE_UNITS,
    priorityFeeMicroLamports,
  } = params;

  const computeBudgetIxs = getComputeBudgetInstructions(
    computeUnits,
    priorityFeeMicroLamports,
  );
  const allInstructions = [...computeBudgetIxs, ...instructions];

  const txMessage = createTransactionMessage({ version: 0 });
  const withFeePayer = setTransactionMessageFeePayerSigner(feePayer, txMessage);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: recentBlockhash, lastValidBlockHeight },
    withFeePayer,
  );
  return appendTransactionMessageInstructions(
    allInstructions as Instruction[],
    withLifetime,
  );
}

export function transactionToInstructions(
  tx: SvmTransaction,
): SvmInstruction[] {
  const computeUnits = tx.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const computeBudgetIxs = getComputeBudgetInstructions(computeUnits);
  return [...computeBudgetIxs, ...tx.instructions];
}
