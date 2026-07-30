import type { Address } from '@solana/kit';

import type { SvmInstruction } from '../types.js';

/**
 * 8-byte discriminator for GetProgramVersion.
 * First 8 bytes of `sha256(b"hyperlane:get-program-version")`.
 * Independent of any program's instruction enum — works on all
 * Hyperlane SVM programs that implement PackageVersioned.
 */
export const GET_PROGRAM_VERSION_DISCRIMINATOR = new Uint8Array([
  150, 230, 176, 162, 236, 96, 183, 171,
]);

/**
 * Builds a GetProgramVersion instruction for any Hyperlane SVM program.
 * No accounts are required.
 */
export function buildGetProgramVersionInstruction(
  programAddress: Address,
): SvmInstruction {
  return {
    programAddress,
    accounts: [],
    data: GET_PROGRAM_VERSION_DISCRIMINATOR,
  };
}
