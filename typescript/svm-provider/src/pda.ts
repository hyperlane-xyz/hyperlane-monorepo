import {
  type Address,
  type ProgramDerivedAddress,
  getProgramDerivedAddress,
  getU32Encoder,
  getUtf8Encoder,
} from '@solana/kit';

// =============================================================================
// Multisig ISM PDA Seeds
// =============================================================================

/**
 * Seeds: ["multisig_ism_message_id", "-", "access_control"]
 */
export async function getMultisigIsmAccessControlPda(
  programId: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('multisig_ism_message_id'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('access_control'),
    ],
  });
}

/**
 * Seeds: ["multisig_ism_message_id", "-", domain.to_le_bytes(), "-", "domain_data"]
 */
export async function getMultisigIsmDomainDataPda(
  programId: Address,
  domain: number,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('multisig_ism_message_id'),
      getUtf8Encoder().encode('-'),
      getU32Encoder().encode(domain),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('domain_data'),
    ],
  });
}

// =============================================================================
// Test ISM PDA Seeds
// =============================================================================

/**
 * Seeds: ["test_ism", "-", "storage"]
 */
export async function getTestIsmStoragePda(
  programId: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('test_ism'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('storage'),
    ],
  });
}

// =============================================================================
// IGP PDA Seeds
// =============================================================================

/**
 * Seeds: ["hyperlane_igp", "-", "program_data"]
 */
export async function getIgpProgramDataPda(
  programId: Address,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('hyperlane_igp'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('program_data'),
    ],
  });
}

/**
 * Seeds: ["hyperlane_igp", "-", "igp", "-", salt]
 * Salt is a 32-byte array.
 */
export async function getIgpAccountPda(
  programId: Address,
  salt: Uint8Array,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('hyperlane_igp'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('igp'),
      getUtf8Encoder().encode('-'),
      salt,
    ],
  });
}

/**
 * Seeds: ["hyperlane_igp", "-", "overhead_igp", "-", salt]
 * Salt is a 32-byte array.
 */
export async function getOverheadIgpAccountPda(
  programId: Address,
  salt: Uint8Array,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('hyperlane_igp'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('overhead_igp'),
      getUtf8Encoder().encode('-'),
      salt,
    ],
  });
}

// =============================================================================
// Mailbox PDA Seeds (for merkle tree hook - outbox is part of mailbox)
// =============================================================================

/**
 * Seeds: ["hyperlane", "-", "outbox", "-", local_domain.to_le_bytes()]
 */
export async function getMailboxOutboxPda(
  programId: Address,
  localDomain: number,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      getUtf8Encoder().encode('hyperlane'),
      getUtf8Encoder().encode('-'),
      getUtf8Encoder().encode('outbox'),
      getUtf8Encoder().encode('-'),
      getU32Encoder().encode(localDomain),
    ],
  });
}
