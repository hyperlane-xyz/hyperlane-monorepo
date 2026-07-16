import type { Address } from '@solana/kit';

import { deriveProgramDataAddress } from '../pda.js';
import {
  CLOCK_SYSVAR_ADDRESS,
  LOADER_V3_PROGRAM_ADDRESS,
  RENT_SYSVAR_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { u32le } from '../codecs/binary.js';
import type { SvmInstruction } from '../types.js';

import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
  writableSignerAddress,
} from './utils.js';

/** BPF Loader Upgradeable SetAuthority discriminant (u32 LE). */
const SET_AUTHORITY_DISCRIMINANT = new Uint8Array([4, 0, 0, 0]);

/** BPF Loader Upgradeable Upgrade discriminant (u32 LE). */
const UPGRADE_DISCRIMINANT = new Uint8Array([3, 0, 0, 0]);

/** BPF Loader Upgradeable ExtendProgramChecked discriminant (variant 9). */
const EXTEND_PROGRAM_CHECKED_DISCRIMINANT = 9;

/**
 * Builds an ExtendProgramChecked instruction (variant 9).
 *
 * Requires the upgrade authority as signer. Variant 6 (ExtendProgram)
 * is rejected on validators with the enable_extend_program_checked
 * feature gate active (default on Agave 3.0+).
 */
export function getExtendProgramCheckedInstruction(
  programDataAddress: Address,
  programAddress: Address,
  authority: Address,
  payer: Address,
  additionalBytes: number,
): SvmInstruction {
  const data = new Uint8Array(8);
  data.set(u32le(EXTEND_PROGRAM_CHECKED_DISCRIMINANT), 0);
  data.set(u32le(additionalBytes), 4);
  return buildInstruction(
    LOADER_V3_PROGRAM_ADDRESS,
    [
      writableAccount(programDataAddress),
      writableAccount(programAddress),
      readonlySignerAddress(authority),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSignerAddress(payer),
    ],
    data,
  );
}

/**
 * Builds a SetAuthority instruction to transfer buffer authority.
 *
 * Used before program upgrades when the buffer writer differs from the
 * program's upgrade authority (the Loader requires both to match).
 */
export function getSetBufferAuthorityInstruction(
  bufferAddress: Address,
  currentAuthority: Address,
  newAuthority: Address,
): SvmInstruction {
  return buildInstruction(
    LOADER_V3_PROGRAM_ADDRESS,
    [
      writableAccount(bufferAddress),
      readonlySignerAddress(currentAuthority),
      readonlyAccount(newAuthority),
    ],
    SET_AUTHORITY_DISCRIMINANT,
  );
}

/**
 * Builds a SetAuthority instruction to transfer upgrade authority
 * of a deployed program to a new address (or renounce it).
 */
export async function getSetUpgradeAuthorityInstruction(
  programAddress: Address,
  currentAuthority: Address,
  newAuthority: Address | null,
): Promise<SvmInstruction> {
  const programDataAddress = await deriveProgramDataAddress(programAddress);
  const accounts = [
    writableAccount(programDataAddress),
    readonlySignerAddress(currentAuthority),
  ];
  if (newAuthority) {
    accounts.push(readonlyAccount(newAuthority));
  }

  return buildInstruction(
    LOADER_V3_PROGRAM_ADDRESS,
    accounts,
    SET_AUTHORITY_DISCRIMINANT,
  );
}

/**
 * Builds an Upgrade instruction using address-only signers.
 *
 * Unlike the @solana-program/loader-v3 getUpgradeInstruction which
 * requires a TransactionSigner for the authority, this accepts a bare
 * Address. The caller (authority holder) signs at transaction submission.
 *
 * Used when the upgrade authority differs from the buffer writer —
 * the authority address is known but the keypair is not available
 * to the code preparing the transaction.
 */
export function getUpgradeInstruction(
  programDataAddress: Address,
  programAddress: Address,
  bufferAddress: Address,
  spillAddress: Address,
  authority: Address,
): SvmInstruction {
  return buildInstruction(
    LOADER_V3_PROGRAM_ADDRESS,
    [
      writableAccount(programDataAddress),
      writableAccount(programAddress),
      writableAccount(bufferAddress),
      writableAccount(spillAddress),
      readonlyAccount(RENT_SYSVAR_ADDRESS),
      readonlyAccount(CLOCK_SYSVAR_ADDRESS),
      readonlySignerAddress(authority),
    ],
    UPGRADE_DISCRIMINANT,
  );
}
