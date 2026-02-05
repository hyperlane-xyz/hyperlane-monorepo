import {
  type AccountMeta,
  AccountRole,
  type AccountSignerMeta,
  type Address,
  type TransactionSigner,
} from '@solana/kit';

import { strip0x } from '@hyperlane-xyz/utils';

import { getInitInstruction } from '../generated/instructions/init.js';
import { getSetAcceptInstruction } from '../generated/instructions/setAccept.js';
import {
  getMultisigIsmAccessControlPda,
  getMultisigIsmDomainDataPda,
  getTestIsmStoragePda,
} from '../pda.js';
import type { SvmInstruction } from '../types.js';

/**
 * Program instruction discriminator prefix used by Hyperlane Sealevel programs.
 * All instructions are prefixed with [1,1,1,1,1,1,1,1] before the Borsh enum discriminant.
 */
const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

/**
 * Multisig ISM instruction discriminants (Borsh enum indices).
 */
const MULTISIG_ISM_INSTRUCTION = {
  Initialize: 0,
  SetValidatorsAndThreshold: 1,
  GetOwner: 2,
  TransferOwnership: 3,
} as const;

// =============================================================================
// Test ISM Instructions
// =============================================================================

/**
 * Creates an instruction to initialize the Test ISM storage PDA.
 * This must be called before any other Test ISM instructions.
 */
export async function getInitTestIsmInstruction(params: {
  payer: TransactionSigner;
  programId: Address;
}): Promise<SvmInstruction> {
  const { payer, programId } = params;
  const [storagePda] = await getTestIsmStoragePda(programId);

  return getInitInstruction(
    {
      payer,
      storagePda,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

/**
 * Creates an instruction to set whether the Test ISM accepts messages.
 * The Test ISM must be initialized first via getInitTestIsmInstruction.
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

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

/**
 * Creates an instruction to initialize the Multisig ISM access control.
 * This sets the owner of the ISM program.
 *
 * The instruction data format is:
 * - 8 bytes: PROGRAM_INSTRUCTION_DISCRIMINATOR [1,1,1,1,1,1,1,1]
 * - 1 byte: Borsh enum discriminant (0 for Initialize)
 */
export async function getInitMultisigIsmInstruction(params: {
  payer: TransactionSigner;
  programId: Address;
}): Promise<SvmInstruction> {
  const { payer, programId } = params;
  const [accessControlPda] = await getMultisigIsmAccessControlPda(programId);

  // Build instruction data: [discriminator prefix][enum variant]
  const data = new Uint8Array(9);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data[8] = MULTISIG_ISM_INSTRUCTION.Initialize;

  // Build accounts - payer is a writable signer (pays for PDA creation)
  const accounts: (AccountMeta | AccountSignerMeta)[] = [
    {
      address: payer.address,
      role: AccountRole.WRITABLE_SIGNER,
      signer: payer,
    },
    { address: accessControlPda, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  return {
    programAddress: programId,
    accounts,
    data,
  } as unknown as SvmInstruction;
}

/**
 * Creates an instruction to set validators and threshold for a domain.
 *
 * The instruction data format is:
 * - 8 bytes: PROGRAM_INSTRUCTION_DISCRIMINATOR [1,1,1,1,1,1,1,1]
 * - 1 byte: Borsh enum discriminant (1 for SetValidatorsAndThreshold)
 * - 4 bytes: domain (u32 LE)
 * - 4 bytes: validators.length (u32 LE)
 * - N * 20 bytes: validators
 * - 1 byte: threshold
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

  // Calculate data size:
  // 8 (discriminator) + 1 (enum) + 4 (domain) + 4 (vec len) + N*20 (validators) + 1 (threshold)
  const dataSize = 8 + 1 + 4 + 4 + validatorBytes.length * 20 + 1;
  const data = new Uint8Array(dataSize);
  const view = new DataView(data.buffer);

  let offset = 0;

  // Discriminator prefix
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, offset);
  offset += 8;

  // Enum variant
  data[offset] = MULTISIG_ISM_INSTRUCTION.SetValidatorsAndThreshold;
  offset += 1;

  // Domain (u32 LE)
  view.setUint32(offset, domain, true);
  offset += 4;

  // Validators vec length (u32 LE)
  view.setUint32(offset, validatorBytes.length, true);
  offset += 4;

  // Validators (each 20 bytes)
  for (const validator of validatorBytes) {
    data.set(validator, offset);
    offset += 20;
  }

  // Threshold (u8)
  data[offset] = threshold;

  // Build accounts - owner is a writable signer (pays for domain PDA creation)
  const accounts: (AccountMeta | AccountSignerMeta)[] = [
    {
      address: owner.address,
      role: AccountRole.WRITABLE_SIGNER,
      signer: owner,
    },
    { address: accessControlPda, role: AccountRole.READONLY },
    { address: domainPda, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  return {
    programAddress: programId,
    accounts,
    data,
  } as unknown as SvmInstruction;
}
