import { PublicKey } from '@solana/web3.js';

import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';

/**
 * Mailbox instruction types matching Rust enum
 * See: rust/sealevel/programs/mailbox/src/instruction.rs
 */
export enum SealevelMailboxInstructionType {
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

export const SealevelMailboxInstructionName: Record<
  SealevelMailboxInstructionType,
  string
> = {
  [SealevelMailboxInstructionType.INIT]: 'Init',
  [SealevelMailboxInstructionType.INBOX_PROCESS]: 'InboxProcess',
  [SealevelMailboxInstructionType.INBOX_SET_DEFAULT_ISM]: 'InboxSetDefaultIsm',
  [SealevelMailboxInstructionType.INBOX_GET_RECIPIENT_ISM]:
    'InboxGetRecipientIsm',
  [SealevelMailboxInstructionType.OUTBOX_DISPATCH]: 'OutboxDispatch',
  [SealevelMailboxInstructionType.OUTBOX_GET_COUNT]: 'OutboxGetCount',
  [SealevelMailboxInstructionType.OUTBOX_GET_LATEST_CHECKPOINT]:
    'OutboxGetLatestCheckpoint',
  [SealevelMailboxInstructionType.OUTBOX_GET_ROOT]: 'OutboxGetRoot',
  [SealevelMailboxInstructionType.GET_OWNER]: 'GetOwner',
  [SealevelMailboxInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
  [SealevelMailboxInstructionType.CLAIM_PROTOCOL_FEES]: 'ClaimProtocolFees',
  [SealevelMailboxInstructionType.SET_PROTOCOL_FEE_CONFIG]:
    'SetProtocolFeeConfig',
};

/**
 * SetDefaultIsm instruction data
 * Matches: rust/sealevel/programs/mailbox/src/instruction.rs
 */
export class SealevelMailboxSetDefaultIsmInstruction {
  newIsm!: Uint8Array;
  newIsmPubkey!: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newIsmPubkey = new PublicKey(this.newIsm);
  }
}

export const SealevelMailboxSetDefaultIsmInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u32'], // Borsh enum discriminator (4 bytes)
        ['data', SealevelMailboxSetDefaultIsmInstruction],
      ],
    },
  ],
  [
    SealevelMailboxSetDefaultIsmInstruction,
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
export class SealevelMailboxTransferOwnershipInstruction {
  newOwner!: Uint8Array | null;
  newOwnerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newOwnerPubkey = this.newOwner
      ? new PublicKey(this.newOwner)
      : undefined;
  }
}

export const SealevelMailboxTransferOwnershipInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u32'],
        ['data', SealevelMailboxTransferOwnershipInstruction],
      ],
    },
  ],
  [
    SealevelMailboxTransferOwnershipInstruction,
    {
      kind: 'struct',
      fields: [
        ['newOwner', { kind: 'option', type: [32] }], // Option<Pubkey>
      ],
    },
  ],
]);
