import { PublicKey } from '@solana/web3.js';

import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';

/**
 * MultisigIsm instruction types matching Rust enum
 * See: rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 */
export enum MultisigIsmInstructionType {
  INIT = 0,
  SET_VALIDATORS_AND_THRESHOLD = 1,
  GET_OWNER = 2,
  TRANSFER_OWNERSHIP = 3,
}

export const MultisigIsmInstructionName: Record<
  MultisigIsmInstructionType,
  string
> = {
  [MultisigIsmInstructionType.INIT]: 'Init',
  [MultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD]:
    'SetValidatorsAndThreshold',
  [MultisigIsmInstructionType.GET_OWNER]: 'GetOwner',
  [MultisigIsmInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
};

/**
 * SetValidatorsAndThreshold instruction data
 * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 *
 * Note: Instruction format AFTER 8-byte program discriminator:
 * [enum_discriminator: u8, domain: u32, validators: Vec<[u8; 20]>, threshold: u8]
 */
export class MultisigIsmSetValidatorsInstruction {
  domain!: number;
  validators!: Uint8Array[]; // Vec<[u8; 20]> - Ethereum addresses
  threshold!: number;

  // Helper to format validators as 0x-prefixed hex strings
  get validatorAddresses(): string[] {
    return this.validators.map((v) => `0x${Buffer.from(v).toString('hex')}`);
  }

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const MultisigIsmSetValidatorsInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'], // Enum discriminator (1 byte, after 8-byte program discriminator)
        ['data', MultisigIsmSetValidatorsInstruction],
      ],
    },
  ],
  [
    MultisigIsmSetValidatorsInstruction,
    {
      kind: 'struct',
      fields: [
        ['domain', 'u32'],
        ['validators', [[20]]], // Vec of 20-byte arrays (Ethereum addresses)
        ['threshold', 'u8'],
      ],
    },
  ],
]);

/**
 * TransferOwnership instruction data
 */
export class MultisigIsmTransferOwnershipInstruction {
  newOwner!: Uint8Array | null;
  newOwnerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newOwnerPubkey = this.newOwner
      ? new PublicKey(this.newOwner)
      : undefined;
  }
}

export const MultisigIsmTransferOwnershipInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', MultisigIsmTransferOwnershipInstruction],
      ],
    },
  ],
  [
    MultisigIsmTransferOwnershipInstruction,
    {
      kind: 'struct',
      fields: [
        ['newOwner', { kind: 'option', type: [32] }], // Option<Pubkey>
      ],
    },
  ],
]);
