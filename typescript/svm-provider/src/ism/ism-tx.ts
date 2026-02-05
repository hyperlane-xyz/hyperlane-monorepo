import type { Address, TransactionSigner } from '@solana/kit';

import { strip0x } from '@hyperlane-xyz/utils';

import { getInitializeInstruction } from '../generated/instructions/initialize.js';
import { getSetAcceptInstruction } from '../generated/instructions/setAccept.js';
import { getSetValidatorsAndThresholdInstruction } from '../generated/instructions/setValidatorsAndThreshold.js';
import {
  getMultisigIsmAccessControlPda,
  getMultisigIsmDomainDataPda,
  getTestIsmStoragePda,
} from '../pda.js';
import type { SvmInstruction } from '../types.js';

// =============================================================================
// Test ISM Instructions
// =============================================================================

/**
 * Creates an instruction to initialize the Test ISM.
 * The Test ISM has no special initialization - it just needs its storage PDA created.
 * This is a no-op since Test ISM doesn't have an init instruction, only setAccept.
 *
 * Note: Test ISM's storage PDA needs to be created, but there's no explicit init.
 * The setAccept instruction will create it if it doesn't exist.
 */
export async function getSetTestIsmAcceptInstruction(params: {
  programId: Address;
  accept: boolean;
}): Promise<SvmInstruction> {
  const { programId, accept } = params;
  const [storagePda] = await getTestIsmStoragePda(programId);

  return getSetAcceptInstruction(
    {
      storagePda,
      args: accept,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

// =============================================================================
// Multisig ISM Instructions
// =============================================================================

/**
 * Creates an instruction to initialize the Multisig ISM access control.
 * This sets the owner of the ISM program.
 */
export async function getInitMultisigIsmInstruction(params: {
  payer: TransactionSigner;
  programId: Address;
}): Promise<SvmInstruction> {
  const { payer, programId } = params;
  const [accessControlPda] = await getMultisigIsmAccessControlPda(programId);

  return getInitializeInstruction(
    {
      payer,
      accessControlPda,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

/**
 * Creates an instruction to set validators and threshold for a domain.
 *
 * @param params.owner - Owner/payer of the ISM (must match access control owner)
 * @param params.programId - Multisig ISM program ID
 * @param params.domain - Domain ID to configure
 * @param params.validators - Array of validator addresses (20-byte hex strings)
 * @param params.threshold - Number of signatures required
 */
export async function getSetValidatorsAndThresholdIx(params: {
  owner: TransactionSigner;
  programId: Address;
  domain: number;
  validators: string[];
  threshold: number;
}): Promise<SvmInstruction> {
  const { owner, programId, domain, validators, threshold } = params;

  const [accessControlPda] = await getMultisigIsmAccessControlPda(programId);
  const [domainPda] = await getMultisigIsmDomainDataPda(programId, domain);

  // Convert hex validator addresses to 20-byte arrays
  const validatorBytes = validators.map((v) => {
    const hex = strip0x(v);
    if (hex.length !== 40) {
      throw new Error(`Invalid validator address length: ${v}`);
    }
    return new Uint8Array(Buffer.from(hex, 'hex'));
  });

  return getSetValidatorsAndThresholdInstruction(
    {
      ownerPayer: owner,
      accessControlPda,
      domainPda,
      domain,
      data: {
        validators: validatorBytes,
        threshold,
      },
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}
