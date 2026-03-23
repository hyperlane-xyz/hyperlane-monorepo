import {
  type Address,
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import type { SvmInstruction, SvmTransaction } from './types.js';
import { DEFAULT_COMPUTE_UNITS } from './constants.js';

export const DEFAULT_WRITE_CHUNK_SIZE = 880;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1;

// Hand-rolled to avoid adding @solana-program/compute-budget as a dependency
// for two trivial instruction encoders.
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
  return appendTransactionMessageInstructions(allInstructions, withLifetime);
}

export function transactionToInstructions(
  tx: SvmTransaction,
): SvmInstruction[] {
  const computeUnits = tx.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const computeBudgetIxs = getComputeBudgetInstructions(computeUnits);
  return [...computeBudgetIxs, ...tx.instructions];
}

// ---------------------------------------------------------------------------
// Unsigned transaction serialization (Rust CLI–compatible)
// ---------------------------------------------------------------------------

const base58Decoder = getBase58Decoder();
const messageEncoder = getCompiledTransactionMessageEncoder();

/** Default blockhash (32 zero bytes) that needs to be replaced at submission time */
const DEFAULT_BLOCKHASH = blockhash('11111111111111111111111111111111');

/**
 * Encodes a number as Solana's compact-u16 wire format.
 * Used for the signature count prefix in serialized transactions.
 */
function encodeCompactU16(value: number): Uint8Array {
  if (value < 0x80) return new Uint8Array([value]);
  if (value < 0x4000)
    return new Uint8Array([(value & 0x7f) | 0x80, value >> 7]);
  return new Uint8Array([
    (value & 0x7f) | 0x80,
    ((value >> 7) & 0x7f) | 0x80,
    value >> 14,
  ]);
}

/**
 * Builds the wire bytes of an unsigned versioned (v0) transaction.
 * Prepends compact-u16 signature count + N zero-filled 64-byte signature
 * slots to the compiled message bytes.
 */
function buildUnsignedTransactionBytes(
  numSigners: number,
  messageBytes: ReadonlyUint8Array,
): Uint8Array {
  const sigCountBytes = encodeCompactU16(numSigners);
  const sigsLen = numSigners * 64;
  const result = new Uint8Array(
    sigCountBytes.length + sigsLen + messageBytes.length,
  );
  result.set(sigCountBytes, 0);
  // signature slots are already zero-filled by Uint8Array constructor
  result.set(messageBytes, sigCountBytes.length + sigsLen);
  return result;
}

/**
 * Serializes an SvmTransaction into base58-encoded formats compatible
 * with the Rust Sealevel CLI output.
 *
 * Produces two representations:
 * - `transaction_base58`: full unsigned v0 transaction (signatures + message)
 * - `message_base58`: compiled message only (no signature wrapper)
 *
 * Both use a default (all-zeros) blockhash since these are unsigned
 * transactions intended for offline / multisig signing workflows.
 */
export function serializeUnsignedTransaction(
  instructions: SvmInstruction[],
  feePayer: Address,
): { transactionBase58: string; messageBase58: string } {
  const txMessage = createTransactionMessage({ version: 0 });
  const withFeePayer = setTransactionMessageFeePayer(feePayer, txMessage);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: DEFAULT_BLOCKHASH, lastValidBlockHeight: 0n },
    withFeePayer,
  );
  const withInstructions = appendTransactionMessageInstructions(
    instructions,
    withLifetime,
  );

  const compiled = compileTransactionMessage(withInstructions);
  const messageBytes = messageEncoder.encode(compiled);

  const transactionBytes = buildUnsignedTransactionBytes(
    compiled.header.numSignerAccounts,
    messageBytes,
  );

  return {
    transactionBase58: base58Decoder.decode(transactionBytes),
    messageBase58: base58Decoder.decode(messageBytes),
  };
}
