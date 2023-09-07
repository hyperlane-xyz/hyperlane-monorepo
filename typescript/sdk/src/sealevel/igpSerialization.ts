import { PublicKey } from '@solana/web3.js';

import { Domain } from '@hyperlane-xyz/utils';

import {
  SealevelAccountDataWrapper,
  getSealevelAccountDataSchema,
} from './serialization';

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs#L24
export enum SealevelInterchainGasPaymasterType {
  // An IGP with gas oracles and that receives lamports as payment.
  Igp = 0,
  // An overhead IGP that points to an inner IGP and imposes a gas overhead for each destination domain.
  OverheadIgp = 1,
}

/**
 * IGP Borsh Schemas
 */

// Config schema, e.g. for use in token data
export class SealevelInterchainGasPaymasterConfig {
  program_id!: Uint8Array;
  type!: number;
  igp_account!: Uint8Array;

  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/trevor/sealevel-validator-rebase/rust/sealevel/libraries/hyperlane-sealevel-token/src/accounts.rs#L21
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
    getSealevelAccountDataSchema(SealevelOverheadIgpData),
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
