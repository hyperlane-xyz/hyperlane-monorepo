import type { ActivityRow } from './status.js';

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

export type SignatureProgress = {
  collection_id: string;
  index?: number | null;
  root?: string | null;
  collected?: number | null;
  threshold: number;
  unavailable: { validator: string; reason: string }[];
};
export type IsmProgress = {
  /** 'unknown' groups observations whose producer did not supply an ISM. */
  ism: string;
  observed_at: string;
  module_type?: string | null;
  validators?: string[] | null;
  threshold?: number | null;
  modules?: string[] | null;
  routed_module?: string | null;
  verified?: number | null;
  verification?: VerificationOutcome | null;
  metadata_error?: string | null;
  signatures?: SignatureProgress | null;
  offchain_read?: OffchainReadProgress | null;
};
export type RelayerProgress = {
  relayer: string;
  phase: Phase;
  observed_at: string;
  failure?: { stage: string; reason: string } | null;
  retry?: {
    reason: string;
    count: number;
    next_attempt_at_millis: number | null;
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
  attempt: number;
  endpoint: number | null;
  http_status: number | null;
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
