import type { providers } from 'ethers';

import type {
  ChainName,
  DerivedHookConfig,
  DerivedIsmConfig,
  DispatchedMessage,
  IsmType,
} from '@hyperlane-xyz/sdk';
import type { Address, SignatureLike } from '@hyperlane-xyz/utils';

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

// ============================================
// Validator info (for multisig ISMs)
// ============================================

/** Validator signature status constants */
export const ValidatorStatus = {
  Signed: 'signed',
  Pending: 'pending',
  Error: 'error',
} as const;

export type ValidatorStatus =
  (typeof ValidatorStatus)[keyof typeof ValidatorStatus];

export interface ValidatorInfo {
  /** Validator address */
  address: Address;
  /** Human-readable name from defaultMultisigConfigs */
  alias?: string;
  /** Signature status */
  status: ValidatorStatus;
  /** Present if status is 'signed' */
  signature?: SignatureLike;
  /** Checkpoint index the validator signed at */
  checkpointIndex?: number;
  /** Error message if status is 'error' */
  error?: string;
}

// ============================================
// Metadata build result types
// ============================================

/** Base interface for all metadata build results */
interface BaseMetadataBuildResult {
  type: IsmType;
  /** ISM contract address */
  ismAddress: Address;
  /** Encoded metadata bytes, undefined if not buildable */
  metadata?: string;
}

/** Result for multisig ISM types */
export interface MultisigMetadataBuildResult extends BaseMetadataBuildResult {
  type:
    | typeof IsmType.MERKLE_ROOT_MULTISIG
    | typeof IsmType.MESSAGE_ID_MULTISIG
    | typeof IsmType.STORAGE_MERKLE_ROOT_MULTISIG
    | typeof IsmType.STORAGE_MESSAGE_ID_MULTISIG;
  /** Required number of signatures */
  threshold: number;
  /** Status of each validator */
  validators: ValidatorInfo[];
  /** Merkle tree index required for this message */
  checkpointIndex: number;
}

/** Result for aggregation ISM types */
export interface AggregationMetadataBuildResult
  extends BaseMetadataBuildResult {
  type: typeof IsmType.AGGREGATION | typeof IsmType.STORAGE_AGGREGATION;
  /** Required number of passing sub-modules */
  threshold: number;
  /** Results from each sub-module (recursive) */
  modules: MetadataBuildResult[];
}

/** Result for routing ISM types */
export interface RoutingMetadataBuildResult extends BaseMetadataBuildResult {
  type:
    | typeof IsmType.ROUTING
    | typeof IsmType.FALLBACK_ROUTING
    | typeof IsmType.AMOUNT_ROUTING
    | typeof IsmType.INTERCHAIN_ACCOUNT_ROUTING;
  /** Origin chain that determined routing */
  originChain: ChainName;
  /** Result from the selected sub-ISM (recursive) */
  selectedIsm: MetadataBuildResult;
}

/** Result for null ISM types (always buildable) */
export interface NullMetadataBuildResult extends BaseMetadataBuildResult {
  type:
    | typeof IsmType.TRUSTED_RELAYER
    | typeof IsmType.TEST_ISM
    | typeof IsmType.OP_STACK
    | typeof IsmType.PAUSABLE
    | typeof IsmType.CCIP;
  /** Always present for null ISMs */
  metadata: string;
}

/** Result for Arbitrum L2 to L1 ISM */
export interface ArbL2ToL1MetadataBuildResult extends BaseMetadataBuildResult {
  type: typeof IsmType.ARB_L2_TO_L1;
  /** Bridge status */
  bridgeStatus: 'confirmed' | 'unconfirmed' | 'executed' | 'verified';
  /** Blocks remaining until challenge period ends (if unconfirmed) */
  blocksRemaining?: number;
}

/** Result for offchain lookup (CCIP-Read) ISM */
export interface CcipReadMetadataBuildResult extends BaseMetadataBuildResult {
  type: typeof IsmType.OFFCHAIN_LOOKUP;
  /** URLs configured for offchain lookup */
  urls: string[];
}

/** Union of all metadata build result types */
export type MetadataBuildResult =
  | MultisigMetadataBuildResult
  | AggregationMetadataBuildResult
  | RoutingMetadataBuildResult
  | NullMetadataBuildResult
  | ArbL2ToL1MetadataBuildResult
  | CcipReadMetadataBuildResult;

// ============================================
// Helper functions
// ============================================

/** Check if metadata was successfully built */
export function isMetadataBuildable(
  result: MetadataBuildResult,
): result is MetadataBuildResult & { metadata: string } {
  return result.metadata !== undefined;
}

/** Get signed validator count for multisig results */
export function getSignedValidatorCount(
  result: MultisigMetadataBuildResult,
): number {
  return result.validators.filter((v) => v.status === ValidatorStatus.Signed)
    .length;
}

/** Check if quorum is met for multisig results */
export function isQuorumMet(result: MultisigMetadataBuildResult): boolean {
  return getSignedValidatorCount(result) >= result.threshold;
}

// ============================================
// MetadataBuilder interface
// ============================================

export interface MetadataBuilder {
  build(context: MetadataContext): Promise<MetadataBuildResult>;
}
