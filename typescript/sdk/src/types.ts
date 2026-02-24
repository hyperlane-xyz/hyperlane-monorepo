import { z } from 'zod';

import type { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import type { Address, Domain } from '@hyperlane-xyz/utils';

import { ZHash } from './metadata/customZodTypes.js';
import type { MultiProvider } from './providers/MultiProvider.js';
import {
  ProtocolReceipt,
  ProtocolTransaction,
} from './providers/ProviderType.js';

// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<ChainName, Value>;
// A map of protocol types to a value type
export type ProtocolMap<Value> = Partial<Record<ProtocolType, Value>>;

export type ChainNameOrId = ChainName | Domain;

export type EvmProvider = ReturnType<MultiProvider['getProvider']>;
export type EvmSigner = ReturnType<MultiProvider['getSigner']>;

// Backwards-compatible aliases while downstream code migrates to EvmProvider/EvmSigner.
export type MultiProviderEvmProvider = EvmProvider;
export type MultiProviderEvmSigner = EvmSigner;

export type Connection = EvmProvider | EvmSigner;

export const OwnableSchema = z.object({
  owner: ZHash,
  ownerOverrides: z.record(ZHash).optional(),
});

export type OwnableConfig = z.infer<typeof OwnableSchema>;

export const DeployedOwnableSchema = OwnableSchema.extend({
  address: ZHash.optional(),
});
export type DeployedOwnableConfig = z.infer<typeof DeployedOwnableSchema>;

export const DerivedOwnableSchema = DeployedOwnableSchema.omit({
  ownerOverrides: true,
}).required();
export type DerivedOwnableConfig = z.infer<typeof DerivedOwnableSchema>;

export const PausableSchema = OwnableSchema.extend({
  paused: z.boolean(),
});
export type PausableConfig = z.infer<typeof PausableSchema>;

export type TypedSigner<T extends ProtocolType> =
  | EvmSigner
  | AltVM.ISigner<ProtocolTransaction<T>, ProtocolReceipt<T>>;

export interface IMultiProtocolSignerManager {
  getMultiProvider(): Promise<MultiProvider>;

  getEVMSigner(chain: ChainName): EvmSigner;

  getSignerAddress(chain: ChainName): Promise<Address>;
  getBalance(params: {
    address: Address;
    chain: ChainName;
    denom?: string;
  }): Promise<Awaited<ReturnType<EvmProvider['getBalance']>>>;
}
