import assert from 'node:assert/strict';
import { it } from 'node:test';

import { DiagnosticsService } from './service.js';
import { reduceStatus, type ActivityRow } from './status.js';
import { Phase, VerificationOutcome } from './types.js';
import { DiagnosticsStream } from './stream.js';
import {
  parseExplorerDiagnostics,
  parseExplorerMessageIds,
} from '../live/protocol.js';
const parseDiagnostics = (url: string) => {
  const params = new URL(url, 'http://localhost').searchParams;
  return parseExplorerDiagnostics(params, parseExplorerMessageIds(params));
};

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';
const id = `0x${'01'.repeat(32)}`;
const ism = `0x${'02'.repeat(32)}`;
function row(
  activity: ActivityRow['activity'],
  number = 1,
  relayer = 'relayer-a',
): ActivityRow {
  return {
    id: String(number),
    message_id: id,
    relayer,
    origin: 1,
    destination: 2,
    observed_at: '2026-11-05 00:00:00+00',
    received_at: '2026-11-05 00:00:01+00',
    version: 1,
    activity,
  };
}
function signature(
  collected: number,
  collection = 'a',
  root = 'root',
  index = 1,
) {
  return {
    type: 'checkpoint',
    ism,
    collection_id: collection,
    threshold: 3,
    summary: {
      collected,
      index,
      root,
      attempts: 1,
      latest_indices: {},
      unavailable: {},
    },
  };
}

void it('reduces threshold progress without combining roots, attempts or relayers', () => {
  const rows = [
    row({
      type: 'validator_set',
      ism,
      validators: ['a', 'b', 'c', 'd'],
      threshold: 3,
    }),
    row(signature(2), 2),
    row(
      {
        type: 'retry',
        reason: 'AwaitingValidatorSignatures',
        retry_count: 1,
        next_attempt_at_millis: 123,
      },
      3,
    ),
  ];
  const state = reduceStatus(rows)[0];
  assert.equal(state?.phase, Phase.AwaitingSignatures);
  assert.equal(state?.modules[0]?.signatures?.collected, 2);
  assert.equal(state?.modules[0]?.signatures?.threshold, 3);
  assert.equal(state?.modules[0]?.validators?.length, 4);
  assert.equal(
    reduceStatus([...rows, row(signature(1, 'a', 'other-root'), 4)])[0]
      ?.modules[0]?.signatures?.collected,
    1,
  );
  assert.equal(
    reduceStatus([...rows, row(signature(1, 'b'), 4)])[0]?.modules[0]
      ?.signatures?.collected,
    1,
  );
  assert.equal(
    reduceStatus([...rows, row(signature(1, 'a', 'root', 2), 4)])[0]?.modules[0]
      ?.signatures?.index,
    2,
  );
  assert.equal(
    reduceStatus([...rows, row(signature(1), 4, 'relayer-b')]).length,
    2,
  );
  const restarted = reduceStatus([
    ...rows,
    row({ type: 'metadata_started', ism }, 4),
  ])[0];
  assert.equal(restarted?.modules[0]?.signatures, undefined);
  assert.equal(restarted?.retry, undefined);
});

void it('keeps aggregation module thresholds separate from signatures and verification', () => {
  const state = reduceStatus([
    row({ type: 'aggregation', ism, modules: ['a', 'b', 'c'], threshold: 2 }),
    row({ type: 'aggregation_progress', ism, verified: 1, threshold: 2 }, 2),
    row({ type: 'ism_verification', ism: 'a', outcome: 'succeeded' }, 3),
    row({ type: 'metadata', ism, error: null }, 4),
  ])[0];
  assert.equal(state?.modules[0]?.verified, 1);
  assert.equal(state?.modules[0]?.threshold, 2);
  assert.equal(state?.modules[0]?.verification, undefined);
  assert.equal(state?.modules[1]?.verification, 'succeeded');
  assert.equal(state?.phase, Phase.Unknown);
  assert.equal(
    reduceStatus([row({ type: 'future_event' })])[0]?.phase,
    Phase.Unknown,
  );
  assert.equal(
    reduceStatus([{ ...row({ type: 'delivered' }), version: 2 }])[0]?.phase,
    Phase.Unknown,
  );
});

void it('validates opt-in subscriptions and history bounds', async () => {
  assert.equal(parseDiagnostics('/messages'), false);
  assert.deepEqual(
    parseDiagnostics(`/messages?diagnostics=true&messageIds=${id},${id}`),
    true,
  );
  for (const url of [
    '/messages?diagnostics=2',
    '/messages?diagnostics=true',
    '/messages?diagnostics=true&messageIds=nope',
  ])
    assert.throws(() => parseDiagnostics(url));
  const db = new DiagnosticsService({
    query: async () => {
      throw new Error('Must not query');
    },
  });
  await assert.rejects(db.history('invalid'));
  await assert.rejects(db.history(id, undefined, 501));
  await assert.rejects(db.history(id, '9223372036854775808'));
});

void it('marks exhausted retries dropped even without a subsequent dropped event', () => {
  const state = reduceStatus([
    row({
      type: 'retry',
      reason: 'ErrorBuildingMetadata',
      retry_count: 3,
      next_attempt_at_millis: 123,
    }),
    row({ type: 'retry_limit_reached', retries: 3, limit: 3 }, 2),
  ])[0];
  assert.equal(state?.phase, Phase.Dropped);
  assert.equal(state?.retry, undefined);
});

void it('marks runtime-denylist eviction inactive until preparation resumes', () => {
  const denied = reduceStatus([
    row({
      type: 'retry',
      reason: 'AwaitingValidatorSignatures',
      retry_count: 3,
      next_attempt_at_millis: 123,
    }),
    row({ type: 'filtered', reason: 'runtime_denylisted' }, 2),
  ])[0];
  assert.equal(denied?.phase, Phase.Dropped);
  assert.equal(denied?.retry, undefined);
  const resumed = reduceStatus([
    row({ type: 'filtered', reason: 'runtime_denylisted' }),
    row({ type: 'progress', stage: 'prepare', outcome: 'started' }, 2),
  ])[0];
  assert.equal(resumed?.phase, Phase.Preparing);
});

void it('retains null-ISM progress separately from known modules and collections', () => {
  const rows = [
    row({
      type: 'validator_set',
      ism: null,
      validators: ['a', 'b'],
      threshold: 3,
    }),
    row({ ...signature(2), ism: null }, 2),
    row(signature(1), 3),
  ];
  const state = reduceStatus(rows)[0];
  assert.equal(state?.modules.length, 2);
  const unknown = state?.modules.find((module) => module.ism === 'unknown');
  assert.deepEqual(unknown?.validators, ['a', 'b']);
  assert.equal(unknown?.threshold, 3);
  assert.equal(unknown?.signatures?.collected, 2);
  assert.equal(
    state?.modules.find((module) => module.ism === ism)?.signatures?.collected,
    1,
  );
  const restarted = reduceStatus([
    ...rows,
    row({ ...signature(1, 'new-collection'), ism: null }, 4),
  ])[0];
  assert.equal(
    restarted?.modules.find((module) => module.ism === 'unknown')?.signatures
      ?.collected,
    1,
  );
});

void it('paginates history and marks truncated snapshot state as partial', async () => {
  let parameters: unknown[] | undefined;
  let sql = '';
  const service = new DiagnosticsService({
    query: async (query, values) => {
      sql = query;
      parameters = values;
      return Array.from({ length: 101 }, (_, i) =>
        row(
          { type: 'progress', stage: 'prepare', outcome: 'started' },
          101 - i,
        ),
      );
    },
  });
  const page = await service.history(id, '102', 100);
  assert.equal(page.has_more, true);
  assert.equal(page.next_before_id, '2');
  assert.deepEqual(parameters, [id.slice(2), 101, '102']);
  assert.match(sql, /id < \$3::bigint/);
  const snapshot = (await service.snapshots([id]))[0];
  assert.equal(snapshot?.partial, true);
  assert.equal(snapshot?.activities[0]?.id, '2');
  assert.equal(snapshot?.activities.at(-1)?.id, '101');
  const broken = new DiagnosticsService({
    query: async () => {
      throw new Error('postgres://secret');
    },
  });
  await assert.rejects(
    broken.history(id),
    (error: Error) => error.message === 'Diagnostics temporarily unavailable',
  );
});

void it('exposes history and status in GraphQL, with explicit disabled errors', async () => {
  const { createScraperProxyApp } = await import('../module.js');
  const diagnostics = new DiagnosticsService({
    query: async () => [row(signature(2))],
  });
  const app = await createScraperProxyApp(
    { query: async () => [] },
    { diagnostics },
  );
  const disabled = await createScraperProxyApp({ query: async () => [] });
  const query = `{ message_activity(message_id: "${id}", limit: 10) { has_more activities { id activity relayer } }
    message_diagnostics(message_id: "${id}") { version partial relayers { phase modules { signatures { collected threshold } } } } }`;
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    });
    assert.equal(result.json().errors, undefined, result.body);
    assert.equal(
      result.json().data.message_diagnostics.relayers[0].modules[0].signatures
        .collected,
      2,
    );
    const unavailable = await disabled.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query },
    });
    assert.equal(
      unavailable.json().errors[0].extensions.code,
      'DIAGNOSTICS_UNAVAILABLE',
    );
  } finally {
    await app.close();
    await disabled.close();
  }
});

void it('clears obsolete retries, failures and nested ISM state across attempts', () => {
  const previous = [
    row({ type: 'ism_verification', ism: 'old-child', outcome: 'succeeded' }),
    row({ type: 'chain_failure', stage: 'prepare', reason: 'rpc_error' }, 2),
    row(
      {
        type: 'retry',
        reason: 'ErrorBuildingMetadata',
        retry_count: 2,
        next_attempt_at_millis: 100,
      },
      3,
    ),
  ];
  const restarted = reduceStatus([
    ...previous,
    row({ type: 'progress', stage: 'prepare', outcome: 'started' }, 4),
  ])[0];
  assert.deepEqual(restarted?.modules, []);
  assert.equal(restarted?.retry, undefined);
  assert.equal(restarted?.failure, undefined);
  const delivered = reduceStatus([
    ...previous,
    row({ type: 'delivered' }, 4),
  ])[0];
  assert.equal(delivered?.phase, Phase.Delivered);
  assert.equal(delivered?.retry, undefined);
  assert.equal(delivered?.failure, undefined);
  const nextCollection = reduceStatus([
    row(signature(2)),
    row(
      {
        type: 'checkpoint',
        ism,
        collection_id: 'new-attempt',
        threshold: 3,
        observation: { type: 'latest_index' },
      },
      2,
    ),
  ])[0];
  assert.equal(nextCollection?.modules[0]?.signatures?.collected, undefined);
});

void it('does not label a collected signature missing when only latest-index discovery fails', () => {
  const state = reduceStatus([
    row(signature(2)),
    row(
      {
        type: 'checkpoint',
        ism,
        collection_id: 'a',
        threshold: 3,
        observation: {
          type: 'unavailable',
          index: null,
          validator: 'validator',
          reason: 'fetch_error',
        },
      },
      2,
    ),
  ])[0];
  assert.equal(state?.modules[0]?.signatures?.collected, 2);
  assert.deepEqual(state?.modules[0]?.signatures?.unavailable, []);
});

void it('normalizes structured retry reasons and unknown verification outcomes', () => {
  const state = reduceStatus([
    row({
      type: 'retry',
      reason: { ApplicationReport: 'ZeroAmount' },
      retry_count: 2,
      next_attempt_at_millis: 1793868325894,
    }),
    row({ type: 'ism_verification', ism, outcome: 'future_outcome' }, 2),
  ])[0];
  assert.equal(state?.retry?.reason, 'ApplicationReport.ZeroAmount');
  assert.equal(state?.modules[0]?.verification, VerificationOutcome.Unknown);
  const unknown = reduceStatus([
    row({
      type: 'retry',
      reason: { future: { nested: true } },
      retry_count: 2,
      next_attempt_at_millis: null,
    }),
  ])[0];
  assert.equal(unknown?.retry?.reason, 'unknown');
});

void it('serves typed progress with the same values over GraphQL and WebSocket', async () => {
  const { createScraperProxyApp } = await import('../module.js');
  const events = [
    row({ type: 'metadata_module', ism, module_type: 'MessageIdMultisig' }),
    row(
      { type: 'validator_set', ism, validators: ['a', 'b', 'c'], threshold: 3 },
      2,
    ),
    row(signature(2, 'a', 'root', 4294967295), 3),
    row(
      {
        type: 'checkpoint',
        ism,
        collection_id: 'a',
        threshold: 3,
        observation: {
          type: 'unavailable',
          index: 4294967295,
          validator: 'c',
          reason: 'missing',
        },
      },
      4,
    ),
    row({ type: 'ism_verification', ism, outcome: 'future_outcome' }, 5),
    row(
      {
        type: 'offchain_read',
        ism,
        state: 'pending',
        attempt: 1,
        endpoint: null,
        http_status: 202,
      },
      6,
    ),
    row({ type: 'chain_failure', stage: 'prepare', reason: 'rpc_error' }, 7),
    row(
      {
        type: 'retry',
        reason: { ApplicationReport: 'ZeroAmount' },
        retry_count: 4294967295,
        next_attempt_at_millis: 1793868325894,
      },
      8,
    ),
  ];
  const service = new DiagnosticsService({
    query: async () => [...events].reverse(),
  });
  const app = await createScraperProxyApp(
    { query: async () => [] },
    { diagnostics: service },
  );
  const stream = new DiagnosticsStream(service);
  const frames: Record<string, unknown>[] = [];
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{
      message_diagnostics(message_id: "${id}") {
        version message_id partial
        relayers {
          relayer phase observed_at failure { stage reason }
          retry { reason count next_attempt_at_millis }
          modules {
            ism observed_at module_type validators threshold verification
            signatures { collection_id index root collected threshold unavailable { validator reason } }
            offchain_read { state attempt endpoint http_status }
          }
        }
      }
    }`,
      },
    });
    assert.equal(result.json().errors, undefined, result.body);
    const snapshot = (await service.snapshots([id]))[0];
    assert(snapshot);
    // GraphQL selection excludes only raw history; progress is identical.
    assert.deepEqual(result.json().data.message_diagnostics, {
      version: snapshot.version,
      message_id: snapshot.message_id,
      partial: snapshot.partial,
      relayers: snapshot.relayers,
    });
    stream.subscribe('127.0.0.1', [id], (frame, complete) => {
      frames.push(frame);
      complete(true);
      return true;
    });
    await stream.flush();
    assert.deepEqual(frames, [{ type: 'diagnostics', data: snapshot }]);
  } finally {
    await stream.stop();
    await app.close();
  }
});

void it('keeps GraphQL progress enums aligned with the WebSocket contract', async () => {
  const { buildSchema, isEnumType } = await import('graphql');
  const { schema } = await import('../scraperdb/schema.js');
  const built = buildSchema(schema);
  for (const [name, values] of [
    ['RelayerPhase', Object.values(Phase)],
    ['VerificationOutcome', Object.values(VerificationOutcome)],
  ] satisfies [string, string[]][]) {
    const type = built.getType(name);
    assert(isEnumType(type));
    assert.deepEqual(
      type.getValues().map(({ name }) => name),
      values,
    );
  }
});

void it('replaces compact checkpoint summaries and clears previous attempt errors', () => {
  const previous = [
    row(signature(2)),
    row({ type: 'metadata', ism, error: 'Awaiting validator signatures' }, 2),
    row({ type: 'chain_failure', stage: 'simulate', reason: 'rpc_error' }, 3),
  ];
  const snapshot = row(
    {
      type: 'checkpoint',
      ism,
      collection_id: 'next',
      threshold: 3,
      summary: {
        index: null,
        root: null,
        collected: 0,
        attempts: 0,
        latest_indices: {},
        unavailable: { validator: 'no_storage' },
      },
    },
    4,
  );
  const signatures = reduceStatus([...previous, snapshot])[0]?.modules[0]
    ?.signatures;
  assert.equal(signatures?.collected, 0);
  assert.equal(signatures?.root, null);
  assert.equal(signatures?.index, null);
  assert.deepEqual(signatures?.unavailable, [
    { validator: 'validator', reason: 'no_storage' },
  ]);
  const restarted = reduceStatus([
    ...previous,
    row({ type: 'progress', stage: 'prepare', outcome: 'started' }, 4),
    row({ type: 'metadata_module', ism, module_type: 'MessageIdMultisig' }, 5),
  ])[0];
  assert.equal(restarted?.failure, undefined);
  assert.equal(restarted?.modules[0]?.metadata_error, undefined);
  assert.equal(restarted?.modules[0]?.signatures, undefined);
  // An aggregation fallback may rebuild the same child within one prepare attempt.
  const rebuilt = reduceStatus([
    ...previous,
    row({ type: 'metadata_module', ism, module_type: 'MessageIdMultisig' }, 4),
    row({ type: 'metadata', ism, error: null }, 5),
  ])[0];
  assert.equal(rebuilt?.modules[0]?.signatures, undefined);
  assert.equal(rebuilt?.modules[0]?.metadata_error, null);
});

void it('still reads per-signature checkpoint events from older relayers', () => {
  const state = reduceStatus([
    row({
      type: 'checkpoint',
      ism,
      collection_id: 'legacy',
      threshold: 2,
      observation: {
        type: 'signature',
        validator: 'a',
        index: 1,
        root: 'root',
        collected: 1,
      },
    }),
  ])[0];
  assert.equal(state?.modules[0]?.signatures?.collected, 1);
});

void it('streams the latest full snapshot and newest cumulative update', async () => {
  const snapshot = row({
    type: 'snapshot',
    state: { phase: 'awaiting_signatures', tree_root: ism, modules: [] },
  });
  const update = row(
    {
      type: 'snapshot_update',
      state: {
        phase: 'awaiting_signatures',
        tree_root: ism,
        modules: [],
        removed_modules: [],
      },
    },
    2,
  );
  const service = new DiagnosticsService({
    query: async (sql) => {
      assert.match(sql, /'snapshot_update'/);
      assert.match(sql, /SELECT max\(anchor.id\)/);
      assert.match(sql, /DISTINCT ON \(relayer, activity->>'type'\)/);
      return [update, snapshot];
    },
  });
  const [result] = await service.snapshots([id]);
  assert.deepEqual(result?.activities, [snapshot, update]);
  assert.equal(result?.partial, false);
});
