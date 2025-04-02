import type { providers } from 'ethers';

import type { DispatchedMessage } from '../../core/types.js';
import type { DerivedHookConfig } from '../../hook/types.js';
import type { DerivedIsmConfig } from '../types.js';

import type { AggregationMetadata } from './aggregation.js';
import type { ArbL2ToL1Metadata } from './arbL2ToL1.js';
import type { MultisigMetadata } from './multisig.js';
import type { NullMetadata } from './null.js';
import type { RoutingMetadata } from './routing.js';

export type StructuredMetadata =
  | NullMetadata
  | MultisigMetadata
  | ArbL2ToL1Metadata
  | AggregationMetadata<any>
  | RoutingMetadata<any>;

export interface MetadataContext<
  IsmContext = DerivedIsmConfig,
  HookContext = DerivedHookConfig,
> {
  message: DispatchedMessage;
  dispatchTx: providers.TransactionReceipt;
  ism: IsmContext;
  hook: HookContext;
}

export interface MetadataBuilder {
  build(context: MetadataContext): Promise<string>;
}
