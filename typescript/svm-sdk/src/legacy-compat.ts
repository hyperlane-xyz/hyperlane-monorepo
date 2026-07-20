/**
 * Converts legacy @solana/web3.js Transaction/VersionedTransaction objects
 * to @solana/kit SvmTransaction format. Used when SDK adapters return
 * legacy transactions but the SvmSigner expects kit-format instructions.
 */
import {
  AccountRole,
  address as castAddress,
  createKeyPairSignerFromBytes,
} from '@solana/kit';
import type {
  AccountMeta as KitAccountMeta,
  Instruction,
  TransactionSigner,
} from '@solana/kit';

import { fetchAddressLookupTableState } from './accounts/address-lookup-table.js';
import { COMPUTE_BUDGET_PROGRAM_ID } from './constants.js';
import type { LegacyKeypair, SvmRpc, SvmTransaction } from './types.js';

// -- Structural interfaces for legacy @solana/web3.js types --
// Defined here to avoid depending on @solana/web3.js.

interface LegacyAccountMeta {
  pubkey: { toBase58(): string };
  isSigner: boolean;
  isWritable: boolean;
}

interface LegacyTransactionInstruction {
  programId: { toBase58(): string };
  keys: LegacyAccountMeta[];
  data: Uint8Array;
}

/** Structural interface matching @solana/web3.js Transaction. */
export interface LegacyTransaction {
  instructions: LegacyTransactionInstruction[];
}

const SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;

function convertAccountMeta(meta: LegacyAccountMeta): KitAccountMeta {
  const address = castAddress(meta.pubkey.toBase58());
  const role = meta.isSigner
    ? meta.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : meta.isWritable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;
  return { address, role };
}

function convertInstruction(ix: LegacyTransactionInstruction): Instruction {
  return {
    programAddress: castAddress(ix.programId.toBase58()),
    accounts: ix.keys.map(convertAccountMeta),
    data: new Uint8Array(ix.data),
  };
}

/**
 * Converts a legacy @solana/web3.js Transaction to the SvmTransaction format
 * expected by SvmSigner. The SetComputeUnitLimit instruction is extracted into
 * `computeUnits` (the signer recreates it). All other instructions — including
 * SetComputeUnitPrice — are preserved as-is.
 *
 * @param legacyTx  Legacy Transaction returned by SDK adapters.
 * @param extraSigners  Keypairs that partial-signed the legacy tx (e.g. random
 *   wallet for message storage PDAs). Converted to @solana/kit TransactionSigners.
 */
export async function convertLegacySolanaTransaction(
  legacyTx: LegacyTransaction,
  extraSigners?: readonly LegacyKeypair[],
): Promise<SvmTransaction> {
  let computeUnits: number | undefined;
  const instructions: Instruction[] = [];

  for (const ix of legacyTx.instructions) {
    const isComputeBudget =
      ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM_ID;

    if (
      isComputeBudget &&
      ix.data[0] === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR &&
      ix.data.length >= 5
    ) {
      // Extract compute unit limit — SvmSigner recreates this instruction
      // from the `computeUnits` field via buildTransactionMessage.
      const dataArr = new Uint8Array(ix.data);
      computeUnits = new DataView(dataArr.buffer, dataArr.byteOffset).getUint32(
        1,
        true,
      );
      continue;
    }

    // Preserve all other instructions including SetComputeUnitPrice.
    instructions.push(convertInstruction(ix));
  }

  let additionalSigners: TransactionSigner[] | undefined;
  if (extraSigners?.length) {
    additionalSigners = await Promise.all(
      extraSigners.map((kp) => createKeyPairSignerFromBytes(kp.secretKey)),
    );
  }

  return {
    instructions,
    computeUnits,
    additionalSigners,
  };
}

/**
 * Detects whether an object is a legacy @solana/web3.js Transaction
 * by checking for the `programId` property on its first instruction.
 */
export function isLegacySolanaTransaction(
  tx: unknown,
): tx is LegacyTransaction {
  if (typeof tx !== 'object' || tx === null) return false;
  // CAST: tx is narrowed to non-null object above; Partial<LegacyTransaction> ensures
  // property access stays in sync with the interface.
  const maybeIx = (tx as Partial<LegacyTransaction>).instructions;
  if (!Array.isArray(maybeIx) || maybeIx.length === 0) return false;
  const first = maybeIx[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'programId' in first &&
    !('programAddress' in first)
  );
}

// -- Structural interfaces for legacy @solana/web3.js VersionedTransaction --
// (v0 messages only — the only version SDK adapters ever produce).

interface LegacyMessageHeader {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
}

interface LegacyCompiledInstruction {
  programIdIndex: number;
  accountKeyIndexes: number[];
  data: Uint8Array;
}

interface LegacyAddressTableLookup {
  accountKey: { toBase58(): string };
  writableIndexes: number[];
  readonlyIndexes: number[];
}

interface LegacyMessageV0 {
  header: LegacyMessageHeader;
  staticAccountKeys: { toBase58(): string }[];
  compiledInstructions: LegacyCompiledInstruction[];
  addressTableLookups: LegacyAddressTableLookup[];
}

/** Structural interface matching @solana/web3.js VersionedTransaction (v0). */
export interface LegacyVersionedTransaction {
  message: LegacyMessageV0;
}

/**
 * Detects whether an object is a legacy @solana/web3.js VersionedTransaction
 * by checking for the v0-message-shaped fields `compiledInstructions` /
 * `staticAccountKeys` on its `message` — present on `MessageV0` but not on
 * the plain `instructions` array a legacy `Transaction` carries.
 */
export function isVersionedSolanaTransaction(
  tx: unknown,
): tx is LegacyVersionedTransaction {
  if (typeof tx !== 'object' || tx === null) return false;
  const message = (tx as Partial<LegacyVersionedTransaction>).message;
  if (typeof message !== 'object' || message === null) return false;
  return (
    Array.isArray((message as Partial<LegacyMessageV0>).compiledInstructions) &&
    Array.isArray((message as Partial<LegacyMessageV0>).staticAccountKeys)
  );
}

/**
 * Converts a legacy @solana/web3.js `VersionedTransaction` (v0) to the
 * `SvmTransaction` format `SvmSigner` expects. Fully decompiles every
 * instruction back to raw addresses — including ones only referenced via
 * an `addressTableLookups` entry, which requires fetching each referenced
 * ALT's on-chain contents — then forwards the same ALT addresses via
 * `addressLookupTables` so kit's own message compiler re-compresses the
 * rebuilt message the same way. Any signatures already present on the
 * incoming transaction are discarded: `SvmSigner` rebuilds the message
 * from scratch against a fresh blockhash regardless, so `extraSigners`
 * (re-signed via `additionalSigners`, same as the legacy `Transaction`
 * path) is what actually matters here, not whatever was pre-signed.
 *
 * @param legacyTx  Legacy VersionedTransaction returned by SDK adapters
 *   once a warp route has ALTs registered (see `SealevelHypTokenAdapter
 *   .populateTransferRemoteTx`'s ALT branch).
 * @param rpc  Needed to fetch each referenced ALT's stored address list —
 *   `writableIndexes`/`readonlyIndexes` are indices into that list, not
 *   into the transaction itself.
 * @param extraSigners  Keypairs that partial-signed the legacy tx (e.g.
 *   random wallet for message storage PDAs). Converted to @solana/kit
 *   TransactionSigners, same as `convertLegacySolanaTransaction`.
 */
export async function convertVersionedSolanaTransaction(
  legacyTx: LegacyVersionedTransaction,
  rpc: SvmRpc,
  extraSigners?: readonly LegacyKeypair[],
): Promise<SvmTransaction> {
  const { message } = legacyTx;

  const lookupTables = await Promise.all(
    message.addressTableLookups.map((lookup) =>
      fetchAddressLookupTableState(
        rpc,
        castAddress(lookup.accountKey.toBase58()),
      ),
    ),
  );

  // Canonical v0 account-key ordering: static keys, then every lookup's
  // writable-indexed addresses (in `addressTableLookups` order), then
  // every lookup's readonly-indexed addresses — matches how
  // @solana/web3.js's own `MessageV0.getAccountKeys()` assembles the full
  // list, which is what `accountKeyIndexes` are indices into.
  const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());
  const writableLookupKeys: string[] = [];
  const readonlyLookupKeys: string[] = [];
  const lookupIsWritable: boolean[] = [];
  message.addressTableLookups.forEach((lookup, i) => {
    const table = lookupTables[i];
    for (const idx of lookup.writableIndexes) {
      writableLookupKeys.push(table.addresses[idx]);
      lookupIsWritable.push(true);
    }
  });
  message.addressTableLookups.forEach((lookup, i) => {
    const table = lookupTables[i];
    for (const idx of lookup.readonlyIndexes) {
      readonlyLookupKeys.push(table.addresses[idx]);
      lookupIsWritable.push(false);
    }
  });
  const allKeys = [...staticKeys, ...writableLookupKeys, ...readonlyLookupKeys];

  const {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  } = message.header;
  const numWritableSigned = numRequiredSignatures - numReadonlySignedAccounts;
  const numWritableUnsigned =
    staticKeys.length - numRequiredSignatures - numReadonlyUnsignedAccounts;

  function roleForIndex(index: number): {
    isSigner: boolean;
    isWritable: boolean;
  } {
    if (index < staticKeys.length) {
      const isSigner = index < numRequiredSignatures;
      const isWritable = isSigner
        ? index < numWritableSigned
        : index - numRequiredSignatures < numWritableUnsigned;
      return { isSigner, isWritable };
    }
    // Lookup-table accounts can never be signers.
    return {
      isSigner: false,
      isWritable: lookupIsWritable[index - staticKeys.length],
    };
  }

  function roleToAccountRole(
    isSigner: boolean,
    isWritable: boolean,
  ): AccountRole {
    if (isSigner)
      return isWritable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER;
    return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
  }

  // Mirrors `convertLegacySolanaTransaction`: extract SetComputeUnitLimit
  // into `computeUnits` (the signer recreates it) rather than passing it
  // through — `buildTransactionMessage` always adds its own, so leaving
  // this one in would duplicate it.
  let computeUnits: number | undefined;
  const instructions: Instruction[] = [];
  for (const ix of message.compiledInstructions) {
    const programAddress = allKeys[ix.programIdIndex];
    const isComputeBudget = programAddress === COMPUTE_BUDGET_PROGRAM_ID;
    if (
      isComputeBudget &&
      ix.data[0] === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR &&
      ix.data.length >= 5
    ) {
      const dataArr = new Uint8Array(ix.data);
      computeUnits = new DataView(dataArr.buffer, dataArr.byteOffset).getUint32(
        1,
        true,
      );
      continue;
    }
    instructions.push({
      programAddress: castAddress(programAddress),
      accounts: ix.accountKeyIndexes.map((idx) => {
        const { isSigner, isWritable } = roleForIndex(idx);
        return {
          address: castAddress(allKeys[idx]),
          role: roleToAccountRole(isSigner, isWritable),
        };
      }),
      data: new Uint8Array(ix.data),
    });
  }

  const addressLookupTables = message.addressTableLookups.map((lookup) =>
    castAddress(lookup.accountKey.toBase58()),
  );

  let additionalSigners: TransactionSigner[] | undefined;
  if (extraSigners?.length) {
    additionalSigners = await Promise.all(
      extraSigners.map((kp) => createKeyPairSignerFromBytes(kp.secretKey)),
    );
  }

  return {
    instructions,
    computeUnits,
    additionalSigners,
    addressLookupTables,
  };
}
