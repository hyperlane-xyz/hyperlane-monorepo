import type { ActivityRow } from './status.js';
import type { DiagnosticError } from '@hyperlane-xyz/utils';

/** Public progress contract shared by GraphQL and WebSocket snapshots. */
export enum Phase {
  Unknown = 'unknown',
  Preparing = 'preparing',
  ReadyToSubmit = 'ready_to_submit',
  AwaitingSignatures = 'awaiting_signatures',
  Retrying = 'retrying',
  Submitting = 'submitting',
  Confirming = 'confirming',
  Delivered = 'delivered',
  Dropped = 'dropped',
}

type UnavailableSignature = {
  validator: string;
  reason: string;
  error?: DiagnosticError | null;
};
export type SignatureProgress = {
  /** Absent in producer snapshots, which deduplicate across collection attempts. */
  collection_id?: string | null;
  index?: number | null;
  root?: string | null;
  collected?: number | null;
  signers?: { validator: string; location?: string | null }[];
  threshold: number;
  unavailable: UnavailableSignature[];
  latest_indices?: { validator: string; index: number | null }[];
  discovery_unavailable?: UnavailableSignature[];
};
export type IsmProgress = {
  node_id?: string;
  children?: { node_id: string; ism: string }[];
  selected_children?: string[];
  /** 'unknown' groups observations whose producer did not supply an ISM. */
  ism: string;
  observed_at: string;
  module_type?: string | null;
  validators?: string[] | null;
  validator_storage?: {
    validator: string;
    states: string[];
    usable: boolean;
    error?: DiagnosticError | null;
  }[];
  threshold?: number | null;
  modules?: string[] | null;
  routed_module?: string | null;
  verified?: number | null;
  verification?: VerificationOutcome | null;
  metadata_error?: string | null;
  error?: DiagnosticError | null;
  verification_error?: DiagnosticError | null;
  signatures?: SignatureProgress | null;
  offchain_read?: OffchainReadProgress | null;
  offchain_reads?: OffchainReadProgress[];
};
export type RelayerProgress = {
  relayer: string;
  phase: Phase;
  observed_at: string;
  tree_root?: string | null;
  failure?: {
    stage: string;
    reason: string;
    error?: DiagnosticError | null;
  } | null;
  confirmation_error?: {
    reason: string;
    error?: DiagnosticError | null;
  } | null;
  retry?: {
    reason: string;
    count: number;
    next_attempt_at_millis: number | null;
    error?: DiagnosticError | null;
  } | null;
  modules: IsmProgress[];
};

export enum VerificationOutcome {
  Unknown = 'unknown',
  Started = 'started',
  Succeeded = 'succeeded',
  Failed = 'failed',
  NoEstimate = 'no_estimate',
  Unavailable = 'unavailable',
}

export type OffchainReadProgress = {
  state: string;
  /** Producer snapshots omit per-request attempt counters. */
  attempt?: number | null;
  endpoint: number | null;
  http_status: number | null;
  error?: DiagnosticError | null;
};

export enum DiagnosticsEventType {
  Snapshot = 'diagnostics',
  Unavailable = 'diagnostics_unavailable',
}

export type MessageDiagnostics = {
  version: 1;
  message_id: string;
  partial: boolean;
  activities: ActivityRow[];
  relayers: RelayerProgress[];
};

export type DiagnosticsFrame =
  | { type: DiagnosticsEventType.Snapshot; data: MessageDiagnostics }
  | {
      type: DiagnosticsEventType.Unavailable;
      message_ids: string[];
      message: string;
    };
