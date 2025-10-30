import { PublicKey } from '@solana/web3.js';

import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';

/**
 * Mailbox instruction types matching Rust enum
 * See: rust/sealevel/programs/mailbox/src/instruction.rs
 */
export enum MailboxInstructionType {
  INIT = 0,
  INBOX_PROCESS = 1,
  INBOX_SET_DEFAULT_ISM = 2,
  INBOX_GET_RECIPIENT_ISM = 3,
  OUTBOX_DISPATCH = 4,
  OUTBOX_GET_COUNT = 5,
  OUTBOX_GET_LATEST_CHECKPOINT = 6,
  OUTBOX_GET_ROOT = 7,
  GET_OWNER = 8,
  TRANSFER_OWNERSHIP = 9,
  CLAIM_PROTOCOL_FEES = 10,
  SET_PROTOCOL_FEE_CONFIG = 11,
}

export const MailboxInstructionName: Record<MailboxInstructionType, string> = {
  [MailboxInstructionType.INIT]: 'Init',
  [MailboxInstructionType.INBOX_PROCESS]: 'InboxProcess',
  [MailboxInstructionType.INBOX_SET_DEFAULT_ISM]: 'InboxSetDefaultIsm',
  [MailboxInstructionType.INBOX_GET_RECIPIENT_ISM]: 'InboxGetRecipientIsm',
  [MailboxInstructionType.OUTBOX_DISPATCH]: 'OutboxDispatch',
  [MailboxInstructionType.OUTBOX_GET_COUNT]: 'OutboxGetCount',
  [MailboxInstructionType.OUTBOX_GET_LATEST_CHECKPOINT]:
    'OutboxGetLatestCheckpoint',
  [MailboxInstructionType.OUTBOX_GET_ROOT]: 'OutboxGetRoot',
  [MailboxInstructionType.GET_OWNER]: 'GetOwner',
  [MailboxInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
  [MailboxInstructionType.CLAIM_PROTOCOL_FEES]: 'ClaimProtocolFees',
  [MailboxInstructionType.SET_PROTOCOL_FEE_CONFIG]: 'SetProtocolFeeConfig',
};

/**
 * SetDefaultIsm instruction data
 * Matches: rust/sealevel/programs/mailbox/src/instruction.rs
 */
export class MailboxSetDefaultIsmInstruction {
  newIsm!: Uint8Array;
  newIsmPubkey!: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newIsmPubkey = new PublicKey(this.newIsm);
  }
}

export const MailboxSetDefaultIsmInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u32'], // Borsh enum discriminator (4 bytes)
        ['data', MailboxSetDefaultIsmInstruction],
      ],
    },
  ],
  [
    MailboxSetDefaultIsmInstruction,
    {
      kind: 'struct',
      fields: [
        ['newIsm', [32]], // Pubkey as 32-byte array
      ],
    },
  ],
]);

/**
 * TransferOwnership instruction data
 * Matches: rust/sealevel/programs/mailbox/src/instruction.rs
 */
export class MailboxTransferOwnershipInstruction {
  newOwner!: Uint8Array | null;
  newOwnerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newOwnerPubkey = this.newOwner
      ? new PublicKey(this.newOwner)
      : undefined;
  }
}

export const MailboxTransferOwnershipInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u32'],
        ['data', MailboxTransferOwnershipInstruction],
      ],
    },
  ],
  [
    MailboxTransferOwnershipInstruction,
    {
      kind: 'struct',
      fields: [
        ['newOwner', { kind: 'option', type: [32] }], // Option<Pubkey>
      ],
    },
  ],
]);
