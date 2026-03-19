import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getAddressCodec } from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import { assert } from '@hyperlane-xyz/utils';

import { concatBytes, u8, u32le, vecBytes } from '../codecs/binary.js';
import { encodeH160 } from '../codecs/shared.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveReplayProtectionPda,
  deriveValidatorAnnouncePda,
  deriveValidatorStorageLocationsPda,
} from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySigner,
  writableAccount,
} from '../instructions/utils.js';

const ADDRESS_CODEC = getAddressCodec();
const TEXT_ENCODER = new TextEncoder();

/**
 * Borsh enum variant indices for the validator announce Instruction enum.
 * See rust/sealevel/programs/validator-announce/src/instruction.rs
 */
enum ValidatorAnnounceInstructionVariant {
  Init = 0,
  Announce = 1,
}

export interface ValidatorAnnounceInitData {
  mailbox: Address;
  localDomain: number;
}

export interface ValidatorAnnounceData {
  /** 20-byte EVM validator address (H160) */
  validator: Uint8Array;
  storageLocation: string;
  /** 65-byte ECDSA signature */
  signature: Uint8Array;
}

function encodeInit(data: ValidatorAnnounceInitData): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      u8(ValidatorAnnounceInstructionVariant.Init),
      ADDRESS_CODEC.encode(data.mailbox),
      u32le(data.localDomain),
    ),
  );
}

function encodeBorshString(value: string): Uint8Array {
  const bytes = TEXT_ENCODER.encode(value);
  return Uint8Array.from(concatBytes(u32le(bytes.length), bytes));
}

function encodeAnnounce(data: ValidatorAnnounceData): Uint8Array {
  assert(
    data.signature.length === 65,
    `ECDSA signature must be 65 bytes (r + s + v), got ${data.signature.length}`,
  );
  return Uint8Array.from(
    concatBytes(
      u8(ValidatorAnnounceInstructionVariant.Announce),
      encodeH160(data.validator),
      encodeBorshString(data.storageLocation),
      vecBytes(data.signature),
    ),
  );
}

/**
 * Computes the replay ID for an announcement = keccak256(validator || storageLocation).
 */
export function computeReplayId(
  validator: Uint8Array,
  storageLocation: string,
): Uint8Array {
  const locationBytes = TEXT_ENCODER.encode(storageLocation);
  const combined = new Uint8Array(validator.length + locationBytes.length);
  combined.set(validator, 0);
  combined.set(locationBytes, validator.length);
  return keccak_256(combined);
}

/**
 * Builds a validator announce Init instruction.
 *
 * Account layout (from Rust init_instruction):
 *  0. [signer]   Payer
 *  1. [readonly]  System program
 *  2. [writable]  ValidatorAnnounce PDA
 */
export async function buildInitValidatorAnnounceInstruction(
  programId: Address,
  payer: TransactionSigner,
  data: ValidatorAnnounceInitData,
): Promise<Instruction> {
  const { address: announcePda } = await deriveValidatorAnnouncePda(programId);
  return buildInstruction(
    programId,
    [
      readonlySigner(payer),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(announcePda),
    ],
    encodeInit(data),
  );
}

/**
 * Builds a validator Announce instruction.
 *
 * Account layout (from Rust process_announce):
 *  0. [signer]   Payer
 *  1. [readonly]  System program
 *  2. [readonly]  ValidatorAnnounce PDA
 *  3. [writable]  ValidatorStorageLocations PDA
 *  4. [writable]  ReplayProtection PDA
 */
export async function buildAnnounceInstruction(
  programId: Address,
  payer: TransactionSigner,
  data: ValidatorAnnounceData,
): Promise<Instruction> {
  const { address: announcePda } = await deriveValidatorAnnouncePda(programId);
  const { address: storageLocationsPda } =
    await deriveValidatorStorageLocationsPda(programId, data.validator);
  const replayId = computeReplayId(data.validator, data.storageLocation);
  const { address: replayProtectionPda } = await deriveReplayProtectionPda(
    programId,
    replayId,
  );

  return buildInstruction(
    programId,
    [
      readonlySigner(payer),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(announcePda),
      writableAccount(storageLocationsPda),
      writableAccount(replayProtectionPda),
    ],
    encodeAnnounce(data),
  );
}
