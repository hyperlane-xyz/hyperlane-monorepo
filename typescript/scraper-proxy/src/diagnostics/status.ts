import { z } from 'zod';

import { Phase, VerificationOutcome, type RelayerProgress } from './types.js';

export const activityRow = z.object({
  id: z.string().regex(/^\d+$/),
  message_id: z.string(),
  relayer: z.string(),
  origin: z.coerce.number(),
  destination: z.coerce.number(),
  observed_at: z.string(),
  received_at: z.string(),
  version: z.number(),
  activity: z.record(z.string(), z.unknown()),
});
export type ActivityRow = z.infer<typeof activityRow>;

const ism = z.string();
const count = z.number().int().nonnegative();
const reason = z.union([z.string(), z.record(z.string(), z.unknown())]);
const verificationOutcome = z.enum(VerificationOutcome);
const event = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chain_failure'),
    stage: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('offchain_read'),
    ism,
    state: z.string(),
    attempt: count,
    endpoint: count.nullable(),
    http_status: count.nullable(),
  }),
  z.object({
    type: z.literal('status'),
    status: z.union([
      z.string(),
      z.object({ Confirm: reason }),
      z.object({ Retry: reason }),
    ]),
  }),
  z.object({ type: z.literal('metadata_started'), ism }),
  z.object({
    type: z.literal('metadata_module'),
    ism,
    module_type: z.string(),
  }),
  z.object({
    type: z.literal('validator_set'),
    ism: ism.nullable(),
    validators: z.array(z.string()),
    threshold: count,
  }),
  z.object({ type: z.literal('routing'), ism, module: ism }),
  z.object({
    type: z.literal('aggregation'),
    ism,
    modules: z.array(ism),
    threshold: count,
  }),
  z.object({
    type: z.literal('aggregation_progress'),
    ism,
    verified: count,
    threshold: count,
  }),
  z.object({ type: z.literal('ism_verification'), ism, outcome: z.string() }),
  z.object({ type: z.literal('metadata'), ism, error: z.string().nullable() }),
  z.object({
    type: z.literal('checkpoint'),
    ism: ism.nullable(),
    collection_id: z.string(),
    threshold: count,
    summary: z
      .object({
        index: count.nullable(),
        root: z.string().nullable(),
        collected: count,
        unavailable: z.record(z.string(), z.string()),
      })
      .optional(),
    observation: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('fetching'), index: count }),
        z.object({
          type: z.literal('signature'),
          index: count,
          root: z.string(),
          collected: count,
          validator: z.string(),
        }),
        z.object({
          type: z.literal('unavailable'),
          index: count.nullable(),
          validator: z.string(),
          reason: z.string(),
        }),
        z.object({ type: z.literal('latest_index') }),
      ])
      .optional(),
  }),
  z.object({
    type: z.literal('retry'),
    reason: reason.nullable(),
    retry_count: count,
    next_attempt_at_millis: count.nullable(),
  }),
  z.object({
    type: z.literal('progress'),
    stage: z.string(),
    outcome: z.string(),
  }),
  z.object({ type: z.literal('delivered') }),
  z.object({ type: z.literal('dropped') }),
  z.object({ type: z.literal('filtered'), reason: z.string() }),
  z.object({ type: z.literal('retry_limit_reached') }),
]);

/** Last observed diagnostics, never authoritative on-chain delivery state.
 * Rows are ordered by insertion ID; each relayer and checkpoint collection is isolated.
 */
export function reduceStatus(rows: ActivityRow[]): RelayerProgress[] {
  const relayers = new Map<string, RelayerProgress>();
  for (const row of rows) {
    let state = relayers.get(row.relayer);
    if (!state) {
      state = {
        relayer: row.relayer,
        phase: Phase.Unknown,
        observed_at: row.observed_at,
        modules: [],
      };
      relayers.set(row.relayer, state);
    }
    state.observed_at = row.observed_at;
    // Unknown versions/types remain visible in history without inventing semantics.
    if (row.version !== 1) continue;
    const parsed = event.safeParse(row.activity);
    if (!parsed.success) continue;
    const value = parsed.data;
    if ('ism' in value) {
      // Null ISMs still carry validator/checkpoint progress from the relayer.
      const moduleIsm = value.ism ?? 'unknown';
      let module = state.modules.find((m) => m.ism === moduleIsm);
      if (
        !module ||
        value.type === 'metadata_started' ||
        value.type === 'metadata_module'
      ) {
        state.modules = state.modules.filter((m) => m.ism !== moduleIsm);
        module = { ism: moduleIsm, observed_at: row.observed_at };
        state.modules.push(module);
      }
      module.observed_at = row.observed_at;
      switch (value.type) {
        case 'metadata_module':
          module.module_type = value.module_type;
          break;
        case 'validator_set':
          module.validators = value.validators;
          module.threshold = value.threshold;
          break;
        case 'routing':
          module.routed_module = value.module;
          break;
        case 'aggregation':
          module.modules = value.modules;
          module.threshold = value.threshold;
          break;
        case 'aggregation_progress':
          module.verified = value.verified;
          module.threshold = value.threshold;
          break;
        case 'ism_verification':
          module.verification =
            verificationOutcome.safeParse(value.outcome).data ??
            VerificationOutcome.Unknown;
          break;
        case 'metadata':
          module.metadata_error = value.error;
          break;
        case 'offchain_read':
          module.offchain_read = {
            state: value.state,
            attempt: value.attempt,
            endpoint: value.endpoint,
            http_status: value.http_status,
          };
          break;
        case 'checkpoint': {
          if (value.summary) {
            module.signatures = {
              collection_id: value.collection_id,
              threshold: value.threshold,
              index: value.summary.index,
              root: value.summary.root,
              collected: value.summary.collected,
              unavailable: Object.entries(value.summary.unavailable).map(
                ([validator, reason]) => ({ validator, reason }),
              ),
            };
            break;
          }
          const observation = value.observation;
          if (!observation) break;
          let progress = module.signatures;
          if (
            !progress ||
            progress.collection_id !== value.collection_id ||
            ('index' in observation &&
              observation.index !== null &&
              progress.index !== observation.index)
          ) {
            progress = {
              collection_id: value.collection_id,
              threshold: value.threshold,
              unavailable: [],
            };
            module.signatures = progress;
          }
          if (observation.type === 'latest_index') break;
          if ('index' in observation && observation.index !== null)
            progress.index = observation.index;
          if (observation.type === 'fetching' || observation.index === null)
            break;
          progress.unavailable = progress.unavailable.filter(
            (v) => v.validator !== observation.validator,
          );
          if (observation.type === 'signature') {
            // Never add counts from different roots or attempts.
            progress.root = observation.root;
            progress.collected = observation.collected;
          } else {
            progress.unavailable.push({
              validator: observation.validator,
              reason: observation.reason,
            });
          }
          break;
        }
      }
    }
    switch (value.type) {
      case 'chain_failure':
        state.failure = { stage: value.stage, reason: value.reason };
        break;
      case 'metadata_started':
        state.phase = Phase.Preparing;
        state.failure = undefined;
        break;
      case 'status':
        if (value.status === 'ReadyToSubmit') state.phase = Phase.ReadyToSubmit;
        else if (value.status === 'FirstPrepareAttempt')
          state.phase = Phase.Preparing;
        else if (typeof value.status === 'object')
          state.phase =
            'Confirm' in value.status
              ? Phase.Confirming
              : retryPhase(value.status.Retry);
        break;
      case 'retry':
        if (value.reason === null) break;
        state.phase = retryPhase(value.reason);
        state.retry = {
          reason: reasonCode(value.reason),
          count: value.retry_count,
          next_attempt_at_millis: value.next_attempt_at_millis,
        };
        break;
      case 'progress':
        if (value.outcome !== 'started') break;
        if (value.stage === 'prepare') {
          state.phase = Phase.Preparing;
          state.modules = [];
          state.failure = undefined;
        } else if (value.stage === 'submit') state.phase = Phase.Submitting;
        else if (value.stage === 'confirm') state.phase = Phase.Confirming;
        break;
      case 'delivered':
        state.phase = Phase.Delivered;
        state.failure = undefined;
        break;
      case 'dropped':
      case 'filtered':
      case 'retry_limit_reached':
        state.phase = Phase.Dropped;
        break;
    }
    if (
      state.phase !== Phase.Retrying &&
      state.phase !== Phase.AwaitingSignatures
    )
      state.retry = undefined;
  }
  return [...relayers.values()];
}

function retryPhase(reason: unknown): Phase {
  return reason === 'AwaitingValidatorSignatures'
    ? Phase.AwaitingSignatures
    : Phase.Retrying;
}

// Serde represents payload-carrying reasons as externally tagged objects.
function reasonCode(reason: string | Record<string, unknown>): string {
  if (typeof reason === 'string') return reason;
  const entries = Object.entries(reason);
  const entry = entries[0];
  return entries.length === 1 && entry && typeof entry[1] === 'string'
    ? `${entry[0]}.${entry[1]}`
    : 'unknown';
}
