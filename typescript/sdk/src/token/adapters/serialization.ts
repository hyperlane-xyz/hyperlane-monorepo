import { PublicKey } from '@solana/web3.js';

import { Domain } from '@hyperlane-xyz/utils';

import {
  SealevelInterchainGasPaymasterConfig,
  SealevelInterchainGasPaymasterConfigSchema,
} from '../../gas/adapters/serialization.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
  getSealevelAccountDataSchema,
} from '../../utils/sealevelSerialization.js';

/**
 * Hyperlane Token Borsh Schema
 */
// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/accounts.rs#L25C12-L25C26
export class SealevelHyperlaneTokenData {
  /// The bump seed for this PDA.
  bump!: number;
  /// The address of the mailbox contract.
  mailbox!: Uint8Array;
  mailbox_pubkey!: PublicKey;
  /// The Mailbox process authority specific to this program as the recipient.
  mailbox_process_authority!: Uint8Array;
  mailbox_process_authority_pubkey!: PublicKey;
  /// The dispatch authority PDA's bump seed.
  dispatch_authority_bump!: number;
  /// The decimals of the local token.
  decimals!: number;
  /// The decimals of the remote token.
  remote_decimals!: number;
  /// Access control owner.
  owner?: Uint8Array;
  owner_pub_key?: PublicKey;
  /// The interchain security module.
  interchain_security_module?: Uint8Array;
  interchain_security_module_pubkey?: PublicKey;
  // The interchain gas paymaster
  interchain_gas_paymaster?: SealevelInterchainGasPaymasterConfig;
  interchain_gas_paymaster_pubkey?: PublicKey;
  interchain_gas_paymaster_account_pubkey?: PublicKey;
  // Gas amounts by destination
  destination_gas?: Map<Domain, bigint>;
  /// Remote routers.
  remote_routers?: Map<Domain, Uint8Array>;
  remote_router_pubkeys: Map<Domain, PublicKey>;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.mailbox_pubkey = new PublicKey(this.mailbox);
    this.mailbox_pubkey = new PublicKey(this.mailbox_process_authority);
    this.owner_pub_key = this.owner ? new PublicKey(this.owner) : undefined;
    this.interchain_security_module_pubkey = this.interchain_security_module
      ? new PublicKey(this.interchain_security_module)
      : undefined;
    this.interchain_gas_paymaster_pubkey = this.interchain_gas_paymaster
      ?.program_id
      ? new PublicKey(this.interchain_gas_paymaster.program_id)
      : undefined;
    this.interchain_gas_paymaster_account_pubkey = this.interchain_gas_paymaster
      ?.igp_account
      ? new PublicKey(this.interchain_gas_paymaster.igp_account)
      : undefined;
    this.remote_router_pubkeys = new Map<number, PublicKey>();
    if (this.remote_routers) {
      for (const [k, v] of this.remote_routers.entries()) {
        this.remote_router_pubkeys.set(k, new PublicKey(v));
      }
    }
  }
}

export const SealevelHyperlaneTokenDataSchema = new Map<any, any>([
  [
    SealevelAccountDataWrapper,
    getSealevelAccountDataSchema(SealevelHyperlaneTokenData),
  ],
  [
    SealevelHyperlaneTokenData,
    {
      kind: 'struct',
      fields: [
        ['bump', 'u8'],
        ['mailbox', [32]],
        ['mailbox_process_authority', [32]],
        ['dispatch_authority_bump', 'u8'],
        ['decimals', 'u8'],
        ['remote_decimals', 'u8'],
        ['owner', { kind: 'option', type: [32] }],
        ['interchain_security_module', { kind: 'option', type: [32] }],
        [
          'interchain_gas_paymaster',
          {
            kind: 'option',
            type: SealevelInterchainGasPaymasterConfig,
          },
        ],
        ['destination_gas', { kind: 'map', key: 'u32', value: 'u64' }],
        ['remote_routers', { kind: 'map', key: 'u32', value: [32] }],
      ],
    },
  ],
  [
    SealevelInterchainGasPaymasterConfig,
    SealevelInterchainGasPaymasterConfigSchema,
  ],
]);

/**
 * Transfer Remote Borsh Schema
 */

// Should match Instruction in https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/instruction.rs
export enum SealevelHypTokenInstruction {
  Init,
  TransferRemote,
  EnrollRemoteRouter,
  EnrollRemoteRouters,
  SetInterchainSecurityModule,
  TransferOwnership,
}

export class SealevelTransferRemoteInstruction {
  destination_domain!: number;
  recipient!: Uint8Array;
  recipient_pubkey!: PublicKey;
  amount_or_id!: number;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.recipient_pubkey = new PublicKey(this.recipient);
  }
}

export const SealevelTransferRemoteSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelTransferRemoteInstruction],
      ],
    },
  ],
  [
    SealevelTransferRemoteInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination_domain', 'u32'],
        ['recipient', [32]],
        ['amount_or_id', 'u256'],
      ],
    },
  ],
]);
