import { PublicKey } from '@solana/web3.js';

import { SealevelInstructionWrapper } from '../utils/sealevelSerialization.js';

/**
 * MultisigIsm instruction types matching Rust enum
 * See: rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 */
export enum SealevelMultisigIsmInstructionType {
  INIT = 0,
  SET_VALIDATORS_AND_THRESHOLD = 1,
  GET_OWNER = 2,
  TRANSFER_OWNERSHIP = 3,
}

export const SealevelMultisigIsmInstructionName: Record<
  SealevelMultisigIsmInstructionType,
  string
> = {
  [SealevelMultisigIsmInstructionType.INIT]: 'Init',
  [SealevelMultisigIsmInstructionType.SET_VALIDATORS_AND_THRESHOLD]:
    'SetValidatorsAndThreshold',
  [SealevelMultisigIsmInstructionType.GET_OWNER]: 'GetOwner',
  [SealevelMultisigIsmInstructionType.TRANSFER_OWNERSHIP]: 'TransferOwnership',
};

/**
 * SetValidatorsAndThreshold instruction data
 * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 *
 * Note: Instruction format AFTER 8-byte program discriminator:
 * [enum_discriminator: u8, domain: u32, validators: Vec<[u8; 20]>, threshold: u8]
 */
export class SealevelMultisigIsmSetValidatorsInstruction {
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

export const SealevelMultisigIsmSetValidatorsInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'], // Enum discriminator (1 byte, after 8-byte program discriminator)
        ['data', SealevelMultisigIsmSetValidatorsInstruction],
      ],
    },
  ],
  [
    SealevelMultisigIsmSetValidatorsInstruction,
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
export class SealevelMultisigIsmTransferOwnershipInstruction {
  newOwner!: Uint8Array | null;
  newOwnerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newOwnerPubkey = this.newOwner
      ? new PublicKey(this.newOwner)
      : undefined;
  }
}

export const SealevelMultisigIsmTransferOwnershipInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelMultisigIsmTransferOwnershipInstruction],
      ],
    },
  ],
  [
    SealevelMultisigIsmTransferOwnershipInstruction,
    {
      kind: 'struct',
      fields: [
        ['newOwner', { kind: 'option', type: [32] }], // Option<Pubkey>
      ],
    },
  ],
]);

/**
 * On-chain account data structures
 * See: rust/sealevel/programs/ism/multisig-ism-message-id/src/accounts.rs
 */

/**
 * SealevelValidatorsAndThreshold - Configuration of a validator set and threshold
 * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/instruction.rs
 */
export class SealevelValidatorsAndThreshold {
  validators!: Uint8Array[]; // Vec<H160> - 20-byte Ethereum addresses
  threshold!: number; // u8

  // Helper to format validators as 0x-prefixed hex strings
  get validatorAddresses(): string[] {
    return this.validators.map((v) => `0x${Buffer.from(v).toString('hex')}`);
  }

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelValidatorsAndThresholdSchema = new Map<any, any>([
  [
    SealevelValidatorsAndThreshold,
    {
      kind: 'struct',
      fields: [
        ['validators', [[20]]], // Vec of 20-byte arrays (Ethereum addresses)
        ['threshold', 'u8'],
      ],
    },
  ],
]);

/**
 * SealevelDomainData - The data of a "domain data" PDA account
 * One of these exists for each domain that's been enrolled
 * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/accounts.rs
 */
export class SealevelDomainData {
  bumpSeed!: number; // u8
  validatorsAndThreshold!: SealevelValidatorsAndThreshold;

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelDomainDataSchema = new Map<any, any>([
  ...SealevelValidatorsAndThresholdSchema,
  [
    SealevelDomainData,
    {
      kind: 'struct',
      fields: [
        ['bumpSeed', 'u8'],
        ['validatorsAndThreshold', SealevelValidatorsAndThreshold],
      ],
    },
  ],
]);

/**
 * SealevelAccessControlData - The data of the access control PDA account
 * Matches: rust/sealevel/programs/ism/multisig-ism-message-id/src/accounts.rs
 */
export class SealevelAccessControlData {
  bumpSeed!: number; // u8
  owner!: Uint8Array | null; // Option<Pubkey>
  ownerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.ownerPubkey = this.owner ? new PublicKey(this.owner) : undefined;
  }
}

export const SealevelAccessControlDataSchema = new Map<any, any>([
  [
    SealevelAccessControlData,
    {
      kind: 'struct',
      fields: [
        ['bumpSeed', 'u8'],
        ['owner', { kind: 'option', type: [32] }], // Option<Pubkey>
      ],
    },
  ],
]);
