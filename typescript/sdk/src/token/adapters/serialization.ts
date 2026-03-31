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
    this.mailbox_process_authority_pubkey = new PublicKey(
      this.mailbox_process_authority,
    );
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
  Init = 0,
  TransferRemote = 1,
  EnrollRemoteRouter = 2,
  EnrollRemoteRouters = 3,
  SetDestinationGasConfigs = 4,
  SetInterchainSecurityModule = 5,
  SetInterchainGasPaymaster = 6,
  TransferOwnership = 7,
}

/**
 * Human-readable names for Hyperlane Token instructions
 */
export const SealevelHypTokenInstructionName: Record<
  SealevelHypTokenInstruction,
  string
> = {
  [SealevelHypTokenInstruction.Init]: 'Init',
  [SealevelHypTokenInstruction.TransferRemote]: 'TransferRemote',
  [SealevelHypTokenInstruction.EnrollRemoteRouter]: 'EnrollRemoteRouter',
  [SealevelHypTokenInstruction.EnrollRemoteRouters]: 'EnrollRemoteRouters',
  [SealevelHypTokenInstruction.SetDestinationGasConfigs]:
    'SetDestinationGasConfigs',
  [SealevelHypTokenInstruction.SetInterchainSecurityModule]:
    'SetInterchainSecurityModule',
  [SealevelHypTokenInstruction.SetInterchainGasPaymaster]:
    'SetInterchainGasPaymaster',
  [SealevelHypTokenInstruction.TransferOwnership]: 'TransferOwnership',
};

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

// ============================================================================
// Governance Instruction Schemas
// ============================================================================

/**
 * RemoteRouterConfig - Configuration for a remote router
 * Matches: rust/sealevel/libraries/hyperlane-sealevel-connection-client/src/router.rs
 */
export class SealevelRemoteRouterConfig {
  domain!: number;
  router!: Uint8Array | null; // Option<H256> - 32-byte address

  get routerAddress(): string | null {
    return this.router ? `0x${Buffer.from(this.router).toString('hex')}` : null;
  }

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelRemoteRouterConfigSchema = {
  kind: 'struct' as const,
  fields: [
    ['domain', 'u32'],
    ['router', { kind: 'option' as const, type: [32] }],
  ],
};

/**
 * GasRouterConfig - Configuration for destination gas
 * Matches: rust/sealevel/libraries/hyperlane-sealevel-connection-client/src/gas_router.rs
 */
export class SealevelGasRouterConfig {
  domain!: number;
  gas!: bigint | null; // Option<u64>

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelGasRouterConfigSchema = {
  kind: 'struct' as const,
  fields: [
    ['domain', 'u32'],
    ['gas', { kind: 'option' as const, type: 'u64' }],
  ],
};

/**
 * EnrollRemoteRouter instruction data
 * Matches: EnrollRemoteRouter(RemoteRouterConfig)
 */
export class SealevelEnrollRemoteRouterInstruction {
  config!: SealevelRemoteRouterConfig;

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelEnrollRemoteRouterInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelEnrollRemoteRouterInstruction],
      ],
    },
  ],
  [
    SealevelEnrollRemoteRouterInstruction,
    {
      kind: 'struct',
      fields: [['config', SealevelRemoteRouterConfig]],
    },
  ],
  [SealevelRemoteRouterConfig, SealevelRemoteRouterConfigSchema],
]);

/**
 * EnrollRemoteRouters instruction data
 * Matches: EnrollRemoteRouters(Vec<RemoteRouterConfig>)
 */
export class SealevelEnrollRemoteRoutersInstruction {
  configs!: SealevelRemoteRouterConfig[];

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelEnrollRemoteRoutersInstructionSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelEnrollRemoteRoutersInstruction],
      ],
    },
  ],
  [
    SealevelEnrollRemoteRoutersInstruction,
    {
      kind: 'struct',
      fields: [['configs', [SealevelRemoteRouterConfig]]],
    },
  ],
  [SealevelRemoteRouterConfig, SealevelRemoteRouterConfigSchema],
]);

/**
 * SetDestinationGasConfigs instruction data
 * Matches: SetDestinationGasConfigs(Vec<GasRouterConfig>)
 */
export class SealevelSetDestinationGasConfigsInstruction {
  configs!: SealevelGasRouterConfig[];

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelSetDestinationGasConfigsInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSetDestinationGasConfigsInstruction],
      ],
    },
  ],
  [
    SealevelSetDestinationGasConfigsInstruction,
    {
      kind: 'struct',
      fields: [['configs', [SealevelGasRouterConfig]]],
    },
  ],
  [SealevelGasRouterConfig, SealevelGasRouterConfigSchema],
]);

/**
 * SetInterchainSecurityModule instruction data
 * Matches: SetInterchainSecurityModule(Option<Pubkey>)
 */
export class SealevelSetInterchainSecurityModuleInstruction {
  ism!: Uint8Array | null; // Option<Pubkey>
  ismPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.ismPubkey = this.ism ? new PublicKey(this.ism) : undefined;
  }
}

export const SealevelSetInterchainSecurityModuleInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSetInterchainSecurityModuleInstruction],
      ],
    },
  ],
  [
    SealevelSetInterchainSecurityModuleInstruction,
    {
      kind: 'struct',
      fields: [['ism', { kind: 'option', type: [32] }]],
    },
  ],
]);

/**
 * InterchainGasPaymasterType with inner Pubkey for instruction serialization
 * This represents the tuple (Pubkey, InterchainGasPaymasterType) in Rust
 * Matches: rust/sealevel/programs/hyperlane-sealevel-igp/src/accounts.rs
 *
 * Note: The Rust enum InterchainGasPaymasterType has variants:
 *   Igp(Pubkey) = 0
 *   OverheadIgp(Pubkey) = 1
 * But in the warp route instruction, it's serialized as Option<(Pubkey, InterchainGasPaymasterType)>
 * where InterchainGasPaymasterType becomes (u8 discriminator, Pubkey)
 */
export class SealevelIgpConfig {
  programId!: Uint8Array; // Pubkey - the IGP program
  igpType!: number; // 0 = Igp, 1 = OverheadIgp
  igpAccount!: Uint8Array; // Pubkey - the IGP account (inner data of the enum)
  programIdPubkey?: PublicKey;
  igpAccountPubkey?: PublicKey;

  get igpTypeName(): string {
    return this.igpType === 0 ? 'Igp' : 'OverheadIgp';
  }

  constructor(fields: any) {
    Object.assign(this, fields);
    this.programIdPubkey = new PublicKey(this.programId);
    this.igpAccountPubkey = new PublicKey(this.igpAccount);
  }
}

export const SealevelIgpConfigSchema = {
  kind: 'struct' as const,
  fields: [
    ['programId', [32]],
    ['igpType', 'u8'],
    ['igpAccount', [32]],
  ],
};

/**
 * SetInterchainGasPaymaster instruction data
 * Matches: SetInterchainGasPaymaster(Option<(Pubkey, InterchainGasPaymasterType)>)
 */
export class SealevelSetInterchainGasPaymasterInstruction {
  igpConfig!: SealevelIgpConfig | null;

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelSetInterchainGasPaymasterInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSetInterchainGasPaymasterInstruction],
      ],
    },
  ],
  [
    SealevelSetInterchainGasPaymasterInstruction,
    {
      kind: 'struct',
      fields: [['igpConfig', { kind: 'option', type: SealevelIgpConfig }]],
    },
  ],
  [SealevelIgpConfig, SealevelIgpConfigSchema],
]);

/**
 * TransferOwnership instruction data for warp routes
 * Matches: TransferOwnership(Option<Pubkey>)
 */
export class SealevelHypTokenTransferOwnershipInstruction {
  newOwner!: Uint8Array | null; // Option<Pubkey>
  newOwnerPubkey?: PublicKey;

  constructor(fields: any) {
    Object.assign(this, fields);
    this.newOwnerPubkey = this.newOwner
      ? new PublicKey(this.newOwner)
      : undefined;
  }
}

export const SealevelHypTokenTransferOwnershipInstructionSchema = new Map<
  any,
  any
>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelHypTokenTransferOwnershipInstruction],
      ],
    },
  ],
  [
    SealevelHypTokenTransferOwnershipInstruction,
    {
      kind: 'struct',
      fields: [['newOwner', { kind: 'option', type: [32] }]],
    },
  ],
]);
