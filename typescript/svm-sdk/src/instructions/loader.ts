import type { Address } from '@solana/kit';

import { deriveProgramDataAddress } from '../deploy/program-deployer.js';
import { LOADER_V3_PROGRAM_ADDRESS } from '../constants.js';
import type { SvmInstruction } from '../types.js';

import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
} from './utils.js';

/**
 * Builds a BPF Loader Upgradeable SetAuthority instruction (discriminant = 4)
 * to transfer upgrade authority of a deployed program to a new address.
 *
 * Uses address-only signers (no embedded keypair) consistent with the rest of
 * the codebase — signing is deferred to transaction submission.
 */
export async function getSetUpgradeAuthorityInstruction(
  programAddress: Address,
  currentAuthority: Address,
  newAuthority: Address | null,
): Promise<SvmInstruction> {
  const programDataAddress = await deriveProgramDataAddress(programAddress);
  // SetAuthority discriminant: u32le(4)
  const data = new Uint8Array([4, 0, 0, 0]);
  const accounts = [
    writableAccount(programDataAddress),
    readonlySignerAddress(currentAuthority),
  ];
  if (newAuthority) {
    accounts.push(readonlyAccount(newAuthority));
  }
  return buildInstruction(LOADER_V3_PROGRAM_ADDRESS, accounts, data);
}
