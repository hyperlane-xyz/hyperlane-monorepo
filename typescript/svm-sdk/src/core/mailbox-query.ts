import { getAddressCodec, type Address } from '@solana/kit';

import { rootLogger } from '@hyperlane-xyz/utils';

import type { ByteCursor } from '../codecs/binary.js';
import { decodeAccountData } from '../codecs/account-data.js';
import { deriveMailboxInboxPda, deriveMailboxOutboxPda } from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import type { SvmRpc } from '../types.js';
import {
  FALLBACK_SIMULATION_PAYER,
  queryProgramVersion,
} from '../version/version-query.js';

const ADDRESS_CODEC = getAddressCodec();

const logger = rootLogger.child({ module: 'mailbox-query' });

// Merkle tree on-chain size: 32 branches * 32 bytes + 8 bytes count.
const MERKLE_TREE_SIZE = 32 * 32 + 8;

export interface MailboxInboxData {
  localDomain: number;
  inboxBumpSeed: number;
  defaultIsm: Address;
  processedCount: bigint;
}

export interface MailboxOutboxData {
  localDomain: number;
  outboxBumpSeed: number;
  owner: Address | null;
  maxProtocolFee: bigint;
  protocolFee: {
    fee: bigint;
    beneficiary: Address;
  };
}

export function decodeMailboxInboxAccount(
  raw: Uint8Array,
): MailboxInboxData | null {
  const { data } = decodeAccountData(raw, (cursor: ByteCursor) => ({
    localDomain: cursor.readU32LE(),
    inboxBumpSeed: cursor.readU8(),
    defaultIsm: cursor.readWithDecoder(ADDRESS_CODEC),
    processedCount: cursor.readU64LE(),
  }));
  return data;
}

export function decodeMailboxOutboxAccount(
  raw: Uint8Array,
): MailboxOutboxData | null {
  const { data } = decodeAccountData(raw, (cursor: ByteCursor) => {
    const localDomain = cursor.readU32LE();
    const outboxBumpSeed = cursor.readU8();

    // Borsh Option<Pubkey>: None = 0x00, Some = 0x01 + 32-byte address
    const hasOwner = cursor.readU8() === 1;
    const owner = hasOwner ? cursor.readWithDecoder(ADDRESS_CODEC) : null;

    // Skip the MerkleTree (1032 bytes)
    cursor.readBytes(MERKLE_TREE_SIZE);

    const maxProtocolFee = cursor.readU64LE();
    const fee = cursor.readU64LE();
    const beneficiary = cursor.readWithDecoder(ADDRESS_CODEC);

    return {
      localDomain,
      outboxBumpSeed,
      owner,
      maxProtocolFee,
      protocolFee: { fee, beneficiary },
    };
  });
  return data;
}

export async function fetchMailboxInboxAccount(
  rpc: SvmRpc,
  programId: Address,
): Promise<MailboxInboxData | null> {
  const { address: inboxPda } = await deriveMailboxInboxPda(programId);
  const raw = await fetchAccountDataRaw(rpc, inboxPda);
  if (!raw) return null;
  return decodeMailboxInboxAccount(raw);
}

export async function fetchMailboxOutboxAccount(
  rpc: SvmRpc,
  programId: Address,
): Promise<MailboxOutboxData | null> {
  const { address: outboxPda } = await deriveMailboxOutboxPda(programId);
  const raw = await fetchAccountDataRaw(rpc, outboxPda);
  if (!raw) return null;
  return decodeMailboxOutboxAccount(raw);
}

/**
 * Queries the on-chain program version for a mailbox program.
 *
 * Uses the mailbox owner as the simulation fee payer when present, falling
 * back to a known-funded mainnet address when the owner is null or the
 * owner-paid simulation fails (e.g. production owner has no SOL).
 * Returns null when both attempts fail (e.g. fallback payer absent on
 * this chain), so reads remain best-effort.
 */
export async function fetchMailboxProgramVersion(
  rpc: SvmRpc,
  programId: Address,
  owner: Address | null,
): Promise<string | null> {
  if (owner) {
    try {
      return await queryProgramVersion(rpc, programId, owner);
    } catch (err) {
      logger.debug(
        'Owner-as-payer simulation failed; retrying with fallback payer',
        { programId, owner, err },
      );
    }
  }
  try {
    return await queryProgramVersion(rpc, programId, FALLBACK_SIMULATION_PAYER);
  } catch (err) {
    logger.debug(
      'Fallback-payer simulation failed; returning null contractVersion',
      { programId, err },
    );
    return null;
  }
}
