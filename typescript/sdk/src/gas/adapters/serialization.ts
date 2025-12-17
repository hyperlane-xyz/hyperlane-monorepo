import { PublicKey } from '@solana/web3.js';

import { type Domain } from '@hyperlane-xyz/utils';

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
 * Gas Oracle Borsh Schema
 */

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L234
export class SealevelRemoteGasData {
  token_exchange_rate!: bigint;
  gas_price!: bigint;
  token_decimals!: number;

  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelRemoteGasDataSchema = {
  kind: 'struct',
  fields: [
    ['token_exchange_rate', 'u128'],
    ['gas_price', 'u128'],
    ['token_decimals', 'u8'],
  ],
};

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L45
export enum SealevelGasOracleType {
  RemoteGasData = 0,
}

export class SealevelGasOracle {
  type!: SealevelGasOracleType;
  data!: SealevelRemoteGasData;

  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelGasOracleSchema = {
  kind: 'struct',
  fields: [
    ['type', 'u8'],
    ['data', SealevelRemoteGasData],
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
  gas_oracles!: Map<number, SealevelGasOracle>;

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
        ['gas_oracles', { kind: 'map', key: 'u32', value: SealevelGasOracle }],
      ],
    },
  ],
  [SealevelGasOracle, SealevelGasOracleSchema],
  [SealevelRemoteGasData, SealevelRemoteGasDataSchema],
]);

/**
 * IGP instruction Borsh Schema
 */

// Should match Instruction in https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/8f8853bcd7105a6dd7af3a45c413b137ded6e888/rust/sealevel/programs/hyperlane-sealevel-igp/src/instruction.rs#L19-L42
export enum SealevelIgpInstruction {
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

/**
 * Gas Oracle Configuration Schemas
 */

export class SealevelGasOracleConfig {
  domain!: number;
  gas_oracle!: SealevelGasOracle | null;

  constructor(domain: number, gasOracle: SealevelGasOracle | null) {
    this.domain = domain;
    this.gas_oracle = gasOracle;
  }
}

export const SealevelGasOracleConfigSchema = {
  kind: 'struct' as const,
  fields: [
    ['domain', 'u32'],
    ['gas_oracle', { kind: 'option' as const, type: SealevelGasOracle }],
  ],
};

export class SealevelGasOverheadConfig {
  destination_domain!: number;
  gas_overhead!: bigint | null;

  constructor(destination_domain: number, gas_overhead: bigint | null) {
    this.destination_domain = destination_domain;
    this.gas_overhead = gas_overhead;
  }
}

export const SealevelGasOverheadConfigSchema = {
  kind: 'struct' as const,
  fields: [
    ['destination_domain', 'u32'],
    ['gas_overhead', { kind: 'option' as const, type: 'u64' }],
  ],
};

/**
 * Instruction Schemas
 */

export class SealevelSetGasOracleConfigsInstruction {
  configs!: SealevelGasOracleConfig[];

  constructor(configs: SealevelGasOracleConfig[]) {
    this.configs = configs;
  }
}

export const SealevelSetGasOracleConfigsInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSetGasOracleConfigsInstruction],
      ],
    },
  ],
  [
    SealevelSetGasOracleConfigsInstruction,
    {
      kind: 'struct',
      fields: [['configs', [SealevelGasOracleConfig]]],
    },
  ],
  [SealevelGasOracleConfig, SealevelGasOracleConfigSchema],
  [SealevelGasOracle, SealevelGasOracleSchema],
  [SealevelRemoteGasData, SealevelRemoteGasDataSchema],
]);

export class SealevelSetDestinationGasOverheadsInstruction {
  configs!: SealevelGasOverheadConfig[];

  constructor(configs: SealevelGasOverheadConfig[]) {
    this.configs = configs;
  }
}

export const SealevelSetDestinationGasOverheadsInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSetDestinationGasOverheadsInstruction],
      ],
    },
  ],
  [
    SealevelSetDestinationGasOverheadsInstruction,
    {
      kind: 'struct',
      fields: [['configs', [SealevelGasOverheadConfig]]],
    },
  ],
  [SealevelGasOverheadConfig, SealevelGasOverheadConfigSchema],
]);
