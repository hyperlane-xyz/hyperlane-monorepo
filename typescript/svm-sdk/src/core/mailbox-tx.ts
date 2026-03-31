import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getAddressCodec } from '@solana/kit';

import { concatBytes, option, u8, u32le, u64le } from '../codecs/binary.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { deriveMailboxInboxPda, deriveMailboxOutboxPda } from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from '../instructions/utils.js';

const ADDRESS_CODEC = getAddressCodec();

/**
 * Borsh enum variant indices for the mailbox Instruction enum.
 * See rust/sealevel/programs/mailbox/src/instruction.rs
 */
enum MailboxInstructionVariant {
  Init = 0,
  // InboxProcess = 1,
  InboxSetDefaultIsm = 2,
  // InboxGetRecipientIsm = 3,
  // OutboxDispatch = 4,
  // OutboxGetCount = 5,
  // OutboxGetLatestCheckpoint = 6,
  // OutboxGetRoot = 7,
  // GetOwner = 8,
  TransferOwnership = 9,
}

export interface MailboxInitData {
  localDomain: number;
  defaultIsm: Address;
  maxProtocolFee: bigint;
  protocolFee: {
    fee: bigint;
    beneficiary: Address;
  };
}

function encodeMailboxInit(data: MailboxInitData): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      u8(MailboxInstructionVariant.Init),
      u32le(data.localDomain),
      ADDRESS_CODEC.encode(data.defaultIsm),
      u64le(data.maxProtocolFee),
      u64le(data.protocolFee.fee),
      ADDRESS_CODEC.encode(data.protocolFee.beneficiary),
    ),
  );
}

/**
 * Builds a mailbox Init instruction.
 *
 * Account layout (from Rust init_instruction):
 *  0. [writable]        System program
 *  1. [writable,signer] Payer
 *  2. [writable]        Inbox PDA
 *  3. [writable]        Outbox PDA
 */
export async function buildInitMailboxInstruction(
  programId: Address,
  payer: TransactionSigner,
  data: MailboxInitData,
): Promise<Instruction> {
  const { address: inboxPda } = await deriveMailboxInboxPda(programId);
  const { address: outboxPda } = await deriveMailboxOutboxPda(programId);
  return buildInstruction(
    programId,
    [
      writableAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSigner(payer),
      writableAccount(inboxPda),
      writableAccount(outboxPda),
    ],
    encodeMailboxInit(data),
  );
}

/**
 * Builds a mailbox InboxSetDefaultIsm instruction.
 *
 * Account layout (from Rust set_default_ism_instruction):
 *  0. [writable]        Inbox PDA
 *  1. [readonly]        Outbox PDA
 *  2. [writable,signer] Owner
 */
export async function buildSetDefaultIsmInstruction(
  programId: Address,
  owner: Address,
  newIsm: Address,
): Promise<Instruction> {
  const { address: inboxPda } = await deriveMailboxInboxPda(programId);
  const { address: outboxPda } = await deriveMailboxOutboxPda(programId);
  return buildInstruction(
    programId,
    [
      writableAccount(inboxPda),
      readonlyAccount(outboxPda),
      writableSignerAddress(owner),
    ],
    Uint8Array.from(
      concatBytes(
        u8(MailboxInstructionVariant.InboxSetDefaultIsm),
        ADDRESS_CODEC.encode(newIsm),
      ),
    ),
  );
}

/**
 * Builds a mailbox TransferOwnership instruction.
 *
 * Account layout (from Rust transfer_ownership_instruction):
 *  0. [writable]        Outbox PDA
 *  1. [writable,signer] Current owner
 */
export async function buildTransferMailboxOwnershipInstruction(
  programId: Address,
  owner: Address,
  newOwner: Address | null,
): Promise<Instruction> {
  const { address: outboxPda } = await deriveMailboxOutboxPda(programId);
  return buildInstruction(
    programId,
    [writableAccount(outboxPda), writableSignerAddress(owner)],
    Uint8Array.from(
      concatBytes(
        u8(MailboxInstructionVariant.TransferOwnership),
        option(newOwner, (addr) => ADDRESS_CODEC.encode(addr)),
      ),
    ),
  );
}
