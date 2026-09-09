import {
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import type { SvmInstruction, SvmTransaction } from './types.js';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  DEFAULT_COMPUTE_UNITS,
} from './constants.js';

// Max data per BPFLoaderUpgradeable Write tx: 1232 packet limit minus tx
// overhead. With 2 signers (payer != authority) overhead is ~355 bytes,
// giving ~877 bytes max. Use 850 to leave margin for all signer configs.
export const DEFAULT_WRITE_CHUNK_SIZE = 850;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1;

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

function validateMemoryBudgets(
  heapSize?: number,
  loadedAccountsDataSizeLimit?: number,
): void {
  if (heapSize !== undefined)
    assert(
      Number.isInteger(heapSize) &&
        heapSize >= 32 * 1024 &&
        heapSize <= 256 * 1024 &&
        heapSize % 1024 === 0,
      'heapSize must be 32-256 KiB in 1 KiB increments',
    );
  if (loadedAccountsDataSizeLimit !== undefined)
    assert(
      Number.isInteger(loadedAccountsDataSizeLimit) &&
        loadedAccountsDataSizeLimit > 0 &&
        loadedAccountsDataSizeLimit <= 64 * 1024 * 1024,
      'loadedAccountsDataSizeLimit must be between 1 and 64 MiB',
    );
}

/** Budget instructions shared by v0 submission and offline serialization. */
export function getMemoryBudgetInstructions(
  heapSize?: number,
  loadedAccountsDataSizeLimit?: number,
): SvmInstruction[] {
  validateMemoryBudgets(heapSize, loadedAccountsDataSizeLimit);
  const instructions: SvmInstruction[] = [];
  for (const [discriminator, value] of [
    [1, heapSize],
    [4, loadedAccountsDataSizeLimit],
  ] as const) {
    if (value === undefined) continue;
    const data = new Uint8Array(5);
    data[0] = discriminator;
    new DataView(data.buffer).setUint32(1, value, true);
    instructions.push({ programAddress: COMPUTE_BUDGET_PROGRAM_ID, data });
  }
  return instructions;
}

export function buildTransactionMessage(params: {
  version?: 0 | 1;
  instructions: SvmInstruction[];
  feePayer: TransactionSigner;
  recentBlockhash: Blockhash;
  lastValidBlockHeight: bigint;
  computeUnits?: number;
  heapSize?: number;
  loadedAccountsDataSizeLimit?: number;
  priorityFeeMicroLamports?: number;
  /**
   * Optional address-lookup tables to compress the message against. The map
   * keys are ALT addresses; values are the addresses stored in each table in
   * on-chain index order. Any account in the message that appears in one of
   * these tables is rewritten to reference the table index instead of being
   * encoded inline.
   */
  addressLookupTables?: AddressesByLookupTableAddress;
}) {
  const {
    instructions,
    feePayer,
    recentBlockhash,
    lastValidBlockHeight,
    computeUnits = DEFAULT_COMPUTE_UNITS,
    priorityFeeMicroLamports,
    addressLookupTables,
  } = params;

  if (params.version === 1) {
    assert(
      !addressLookupTables || Object.keys(addressLookupTables).length === 0,
      'v1 transactions do not support address lookup tables',
    );
    assert(
      priorityFeeMicroLamports === undefined ||
        (Number.isSafeInteger(priorityFeeMicroLamports) &&
          priorityFeeMicroLamports >= 0),
      'priorityFeeMicroLamports must be a nonnegative safe integer',
    );
    let instructionComputeUnits: number | undefined;
    let heapSize = params.heapSize;
    let loadedAccountsDataSizeLimit = params.loadedAccountsDataSizeLimit;
    let price =
      priorityFeeMicroLamports === undefined
        ? undefined
        : BigInt(priorityFeeMicroLamports);
    // Legacy SDK adapters preserve SetComputeUnitPrice when converting instructions.
    // V1 must move that price into its header, never send a ComputeBudget instruction.
    const v1Instructions = instructions
      .filter((ix) => {
        if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM_ID) return true;
        if (
          ix.data?.length === 5 &&
          (ix.data[0] === 1 || ix.data[0] === 2 || ix.data[0] === 4)
        ) {
          const value = new DataView(Uint8Array.from(ix.data).buffer).getUint32(
            1,
            true,
          );
          if (ix.data[0] === 1) {
            assert(heapSize === undefined, 'Duplicate heap configuration');
            heapSize = value;
          } else if (ix.data[0] === 2) {
            assert(
              instructionComputeUnits === undefined,
              'Duplicate compute unit configuration',
            );
            assert(
              params.computeUnits === undefined ||
                params.computeUnits === value,
              'Conflicting compute unit configuration',
            );
            instructionComputeUnits = value;
          } else {
            assert(
              loadedAccountsDataSizeLimit === undefined,
              'Duplicate loaded-account configuration',
            );
            loadedAccountsDataSizeLimit = value;
          }
          return false;
        }
        assert(
          ix.data?.length === 9 && ix.data[0] === 3,
          'Unsupported v1 compute-budget instruction',
        );
        assert(price === undefined, 'Duplicate priority fee configuration');
        price = new DataView(Uint8Array.from(ix.data).buffer).getBigUint64(
          1,
          true,
        );
        return false;
      })
      .map((ix) => ({
        ...ix,
        accounts: ix.accounts?.map((account) => {
          assert(
            !('lookupTableAddress' in account),
            'v1 instructions cannot reference lookup tables',
          );
          return account;
        }),
      }));
    const resolvedComputeUnits = instructionComputeUnits ?? computeUnits;
    assert(
      Number.isInteger(resolvedComputeUnits) &&
        resolvedComputeUnits > 0 &&
        resolvedComputeUnits <= 1_400_000,
      'computeUnits must be an integer between 1 and 1400000',
    );
    validateMemoryBudgets(heapSize, loadedAccountsDataSizeLimit);
    const message = setTransactionMessageConfig(
      {
        computeUnitLimit: resolvedComputeUnits,
        // V1 has no implicit loaded-account budget. Match the legacy runtime maximum.
        loadedAccountsDataSizeLimit:
          loadedAccountsDataSizeLimit ?? 64 * 1024 * 1024,
        ...(heapSize === undefined ? {} : { heapSize }),
        ...(price
          ? {
              priorityFeeLamports:
                (price * BigInt(resolvedComputeUnits) + 999_999n) / 1_000_000n,
            }
          : {}),
      },
      createTransactionMessage({ version: 1 }),
    );
    return appendTransactionMessageInstructions(
      v1Instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: recentBlockhash, lastValidBlockHeight },
        setTransactionMessageFeePayerSigner(feePayer, message),
      ),
    );
  }

  const computeBudgetIxs = getComputeBudgetInstructions(
    computeUnits,
    priorityFeeMicroLamports,
  );
  const allInstructions = [
    ...computeBudgetIxs,
    ...getMemoryBudgetInstructions(
      params.heapSize,
      params.loadedAccountsDataSizeLimit,
    ),
    ...instructions,
  ];

  const txMessage = createTransactionMessage({ version: 0 });
  const withFeePayer = setTransactionMessageFeePayerSigner(feePayer, txMessage);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: recentBlockhash, lastValidBlockHeight },
    withFeePayer,
  );
  const withInstructions = appendTransactionMessageInstructions(
    allInstructions,
    withLifetime,
  );
  if (!addressLookupTables) return withInstructions;
  return compressTransactionMessageUsingAddressLookupTables(
    withInstructions,
    addressLookupTables,
  );
}

export function transactionToInstructions(
  tx: SvmTransaction,
): SvmInstruction[] {
  const computeUnits = tx.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const computeBudgetIxs = getComputeBudgetInstructions(computeUnits);
  return [...computeBudgetIxs, ...tx.instructions];
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
  /**
   * Resolved ALT map. When the source tx uses ALTs at submit time, the
   * same compression must be applied here — otherwise the printable
   * output (Squads / offline signing) serializes accounts inline and may
   * exceed the 1232-byte packet limit or diverge from runtime semantics.
   * Callers usually obtain this map by handing an ALT-address list
   * through the signer's resolver rather than building it by hand.
   */
  addressLookupTables?: AddressesByLookupTableAddress,
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

  const compressed = addressLookupTables
    ? compressTransactionMessageUsingAddressLookupTables(
        withInstructions,
        addressLookupTables,
      )
    : withInstructions;

  const compiled = compileTransactionMessage(compressed);
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
