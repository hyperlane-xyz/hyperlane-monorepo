import { PublicKey } from '@solana/web3.js';

import { Domain } from '@hyperlane-xyz/utils';

import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
  getSealevelAccountDataSchema,
  getSealevelSimulationReturnDataSchema,
} from '../../utils/sealevelSerialization.js';

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L24
export enum SealevelInterchainGasPaymasterType {
  // An IGP with gas oracles and that receives lamports as payment.
  Igp = 0,
  // An overhead IGP that points to an inner IGP and imposes a gas overhead for each destination domain.
  OverheadIgp = 1,
}

/**
 * IGP Config Borsh Schema
 */

// Config schema, e.g. for use in token data
export class SealevelInterchainGasPaymasterConfig {
  program_id!: Uint8Array;
  program_id_pubkey!: PublicKey;
  type!: SealevelInterchainGasPaymasterType;
  igp_account?: Uint8Array;
  igp_account_pub_key?: PublicKey;

  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.program_id_pubkey = new PublicKey(this.program_id);
    this.igp_account_pub_key = this.igp_account
      ? new PublicKey(this.igp_account)
      : undefined;
  }
}

export const SealevelInterchainGasPaymasterConfigSchema = {
  kind: 'struct',
  fields: [
    ['program_id', [32]],
    ['type', 'u8'],
    ['igp_account', [32]],
  ],
};

/**
 * IGP Program Data Borsh Schema
 */

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L91
export class SealevelOverheadIgpData {
  /// The bump seed for this PDA.
  bump!: number;
  /// The salt used to derive the overhead IGP PDA.
  salt!: Uint8Array;
  /// The owner of the overhead IGP.
  owner?: Uint8Array;
  owner_pub_key?: PublicKey;
  /// The inner IGP account.
  inner!: Uint8Array;
  inner_pub_key!: PublicKey;
  /// The gas overheads to impose on gas payments to each destination domain.
  gas_overheads!: Map<Domain, bigint>;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.owner_pub_key = this.owner ? new PublicKey(this.owner) : undefined;
    this.inner_pub_key = new PublicKey(this.inner);
  }
}

export const SealevelOverheadIgpDataSchema = new Map<any, any>([
  [
    SealevelAccountDataWrapper,
    getSealevelAccountDataSchema(SealevelOverheadIgpData, [8]),
  ],
  [
    SealevelOverheadIgpData,
    {
      kind: 'struct',
      fields: [
        ['bump', 'u8'],
        ['salt', [32]],
        ['owner', { kind: 'option', type: [32] }],
        ['inner', [32]],
        ['gas_overheads', { kind: 'map', key: 'u32', value: 'u64' }],
      ],
    },
  ],
]);

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L159
export class SealevelIgpData {
  /// The bump seed for this PDA.
  bump_seed!: number;
  // The salt used to derive the IGP PDA.
  salt!: Uint8Array; // 32 bytes
  /// The owner of the IGP.
  owner?: Uint8Array | null;
  owner_pub_key?: PublicKey;
  /// The beneficiary of the IGP.
  beneficiary!: Uint8Array; // 32 bytes
  beneficiary_pub_key!: PublicKey;
  gas_oracles!: Map<number, bigint>;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.owner_pub_key = this.owner ? new PublicKey(this.owner) : undefined;
    this.beneficiary_pub_key = new PublicKey(this.beneficiary);
  }
}

export const SealevelIgpDataSchema = new Map<any, any>([
  [
    SealevelAccountDataWrapper,
    getSealevelAccountDataSchema(SealevelIgpData, [8]),
  ],
  [
    SealevelIgpData,
    {
      kind: 'struct',
      fields: [
        ['bump_seed', 'u8'],
        ['salt', [32]],
        ['owner', { kind: 'option', type: [32] }],
        ['beneficiary', [32]],
        ['gas_oracles', { kind: 'map', key: 'u32', value: 'u64' }],
      ],
    },
  ],
]);

/**
 * IGP instruction Borsh Schema
 */

// Should match Instruction in https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/8f8853bcd7105a6dd7af3a45c413b137ded6e888/rust/sealevel/programs/hyperlane-sealevel-igp/src/instruction.rs#L19-L42
export enum SealeveIgpInstruction {
  Init,
  InitIgp,
  InitOverheadIgp,
  PayForGas,
  QuoteGasPayment,
  TransferIgpOwnership,
  TransferOverheadIgpOwnership,
  SetIgpBeneficiary,
  SetDestinationGasOverheads,
  SetGasOracleConfigs,
  Claim,
}

export class SealevelIgpQuoteGasPaymentInstruction {
  destination_domain!: number;
  gas_amount!: bigint;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelIgpQuoteGasPaymentSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelIgpQuoteGasPaymentInstruction],
      ],
    },
  ],
  [
    SealevelIgpQuoteGasPaymentInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination_domain', 'u32'],
        ['gas_amount', 'u64'],
      ],
    },
  ],
]);

export class SealevelIgpQuoteGasPaymentResponse {
  payment_quote!: bigint;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelIgpQuoteGasPaymentResponseSchema = new Map<any, any>([
  [
    SealevelAccountDataWrapper,
    getSealevelSimulationReturnDataSchema(SealevelIgpQuoteGasPaymentResponse),
  ],
  [
    SealevelIgpQuoteGasPaymentResponse,
    {
      kind: 'struct',
      fields: [['payment_quote', 'u64']],
    },
  ],
]);
