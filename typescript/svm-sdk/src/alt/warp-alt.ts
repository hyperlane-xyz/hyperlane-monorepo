import { type Address, address as parseAddress } from '@solana/kit';

import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';

export interface SvmCoreDeploymentAltIgpContext {
  programId: Address;
  igpSalt: Uint8Array;
  includeOverheadIgp?: boolean;
}

/**
 * Derives the chain-level address set every SVM warp route on a given
 * chain wants in its ALTs: SDK constants, mailbox/outbox, and the
 * optional IGP quad. Output is set-deduped and base58-sorted so the
 * caller gets a canonical, diff-stable list. ALT-tx semantics are
 * order-agnostic — `compressTransactionMessageUsingAddressLookupTables`
 * is a pure set-membership index substitution — so any caller-chosen
 * ordering is safe on-chain; sorting is purely for predictable diffs.
 */
export async function deriveCoreDeploymentAltAddresses(
  mailbox: Address,
  igp?: SvmCoreDeploymentAltIgpContext,
): Promise<Address[]> {
  const outbox = (await deriveMailboxOutboxPda(mailbox)).address;
  const out: Address[] = [
    SYSTEM_PROGRAM_ADDRESS,
    SPL_NOOP_PROGRAM_ADDRESS,
    SPL_TOKEN_PROGRAM_ADDRESS,
    mailbox,
    outbox,
  ];

  if (igp) {
    const { programId, igpSalt, includeOverheadIgp } = igp;

    const programData = await deriveIgpProgramDataPda(programId);
    const igpAccount = await deriveIgpAccountPda(programId, igpSalt);
    out.push(programId, programData.address, igpAccount.address);

    if (includeOverheadIgp) {
      const overhead = await deriveOverheadIgpAccountPda(programId, igpSalt);
      out.push(overhead.address);
    }
  }
  return [...new Set(out.map(parseAddress))].sort();
}
