import {
  AccountRole,
  type Address,
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  address,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import type { SvmInstruction, SvmTransaction } from './types.js';
import { DEFAULT_COMPUTE_UNITS } from './constants.js';

type Web3PublicKeyLike = { toBase58(): string };
export type Web3KeypairLike = {
  publicKey: Web3PublicKeyLike;
  secretKey: Uint8Array;
};

export type Web3InstructionLike = {
  programId: Web3PublicKeyLike;
  keys?: readonly {
    pubkey: Web3PublicKeyLike;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  data?: Uint8Array;
};

export type Web3TransactionLike = {
  instructions: readonly (SvmInstruction | Web3InstructionLike)[];
  feePayer?: Address | Web3PublicKeyLike | null;
  computeUnits?: number;
  // Compat for callers that still attach web3 keypairs/signers to raw web3 txs.
  // `SvmSigner.send()` consumes this before rebuilding the normalized tx message.
  additionalSigners?: readonly (TransactionSigner | Web3KeypairLike)[];
  // CLI forwards this sibling field today; signer compat treats it the same way.
  extraSigners?: readonly unknown[];
  skipPreflight?: boolean;
};

function isSvmInstruction(
  instruction: SvmInstruction | Web3InstructionLike,
): instruction is SvmInstruction {
  return 'programAddress' in instruction;
}

function isWeb3PublicKeyLike(
  value: Address | Web3PublicKeyLike | null | undefined,
): value is Web3PublicKeyLike {
  return !!value && typeof value === 'object' && 'toBase58' in value;
}

function accountRoleFromWeb3Meta(meta: {
  isSigner: boolean;
  isWritable: boolean;
}): AccountRole {
  if (meta.isSigner) {
    return meta.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER;
  }

  return meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

export function normalizeInstruction(
  instruction: SvmInstruction | Web3InstructionLike,
): SvmInstruction {
  if (isSvmInstruction(instruction)) return instruction;

  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: (instruction.keys ?? []).map((key) => ({
      address: address(key.pubkey.toBase58()),
      role: accountRoleFromWeb3Meta(key),
    })),
    data: instruction.data ? new Uint8Array(instruction.data) : undefined,
  };
}

export function normalizeTransaction(
  tx: SvmTransaction | Web3TransactionLike,
): SvmTransaction {
  const { computeUnits, instructions, skipPreflight } = tx;
  return {
    // Normalize only the message fields that survive blockhash refresh + re-sign.
    // Extra signer metadata is handled separately at the signer boundary.
    computeUnits,
    feePayer: isWeb3PublicKeyLike(tx.feePayer)
      ? address(tx.feePayer.toBase58())
      : (tx.feePayer ?? undefined),
    instructions: instructions.map(normalizeInstruction),
    skipPreflight,
  };
}

// Max data per BPFLoaderUpgradeable Write tx: 1232 packet limit minus tx
// overhead. With 2 signers (payer != authority) overhead is ~355 bytes,
// giving ~877 bytes max. Use 850 to leave margin for all signer configs.
export const DEFAULT_WRITE_CHUNK_SIZE = 850;
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
  units?: number,
  microLamports?: number,
): SvmInstruction[] {
  const resolvedUnits = arguments.length === 0 ? DEFAULT_COMPUTE_UNITS : units;
  const instructions: SvmInstruction[] = [];
  if (resolvedUnits !== undefined) {
    instructions.push(createSetComputeUnitLimitInstruction(resolvedUnits));
  }
  if (microLamports !== undefined && microLamports > 0) {
    instructions.push(
      createSetComputeUnitPriceInstruction(BigInt(microLamports)),
    );
  }
  return instructions;
}

function hasComputeBudgetInstructionKind(
  instructions: readonly SvmInstruction[],
  discriminator: number,
): boolean {
  return instructions.some(
    (instruction) =>
      instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ID &&
      instruction.data?.[0] === discriminator,
  );
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

  const normalizedInstructions = instructions.map(normalizeInstruction);
  const computeBudgetIxs = getComputeBudgetInstructions(
    hasComputeBudgetInstructionKind(normalizedInstructions, 2)
      ? undefined
      : computeUnits,
    hasComputeBudgetInstructionKind(normalizedInstructions, 3)
      ? undefined
      : priorityFeeMicroLamports,
  );
  const allInstructions = [...computeBudgetIxs, ...normalizedInstructions];

  const txMessage = createTransactionMessage({ version: 0 });
  const withFeePayer = setTransactionMessageFeePayerSigner(feePayer, txMessage);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: recentBlockhash, lastValidBlockHeight },
    withFeePayer,
  );
  return appendTransactionMessageInstructions(allInstructions, withLifetime);
}

export function transactionToInstructions(
  tx: SvmTransaction | Web3TransactionLike,
): SvmInstruction[] {
  const normalizedTx = normalizeTransaction(tx);
  const computeUnits = normalizedTx.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const computeBudgetIxs = getComputeBudgetInstructions(
    hasComputeBudgetInstructionKind(normalizedTx.instructions, 2)
      ? undefined
      : computeUnits,
  );
  return [...computeBudgetIxs, ...normalizedTx.instructions];
}

// ---------------------------------------------------------------------------
// Unsigned transaction serialization (Squads-compatible v0 format)
// ---------------------------------------------------------------------------

const base58Decoder = getBase58Decoder();
const messageEncoder = getCompiledTransactionMessageEncoder();
const shortU16Encoder = getShortU16Encoder();

/** Default blockhash (32 zero bytes) that needs to be replaced at submission time */
const DEFAULT_BLOCKHASH = blockhash('11111111111111111111111111111111');

/**
 * Builds the wire bytes of an unsigned versioned (v0) transaction.
 * Prepends compact-u16 signature count + N zero-filled 64-byte signature
 * slots to the compiled message bytes.
 */
function buildUnsignedTransactionBytes(
  numSigners: number,
  messageBytes: ReadonlyUint8Array,
): Uint8Array {
  const sigCountBytes = shortU16Encoder.encode(numSigners);
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
 * with the Squads multisig UI.
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
    instructions.map(normalizeInstruction),
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
