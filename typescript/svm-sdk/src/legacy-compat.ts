/**
 * Converts legacy @solana/web3.js Transaction objects to @solana/kit SvmTransaction format.
 * Used when SDK adapters return legacy Transactions but the SvmSigner expects kit-format instructions.
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

import { COMPUTE_BUDGET_PROGRAM_ID } from './constants.js';
import type { LegacyKeypair, SvmTransaction } from './types.js';

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
