// Oracle corpus for the Zig diagnostics reducer.
// Runs the TypeScript DiagnosticsService (snapshot selection + reduceStatus) over
// hand-written and generated activity histories and records the exact
// JSON.stringify bytes. Regenerate from the repository root:
//   PATH=$HOME/.nvm/versions/node/v26.12.1/bin:$PATH \
//     pnpm -C zig/scraper-proxy exec tsx src/diagnostics/testdata/gen-corpus.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphQLError } from 'graphql';

import { DiagnosticsService } from '../../../../../typescript/scraper-proxy/src/diagnostics/service.js';

type RawRow = {
  id: string;
  message_id: string;
  relayer: string;
  origin: number | string;
  destination: number | string;
  observed_at: string;
  received_at: string;
  // A string version is only used to prove the row schema rejects it.
  version: number | string;
  // Exactly what PostgreSQL would hand node-pg; parsed with JSON.parse.
  activity_text: string;
};
type Case = {
  name: string;
  ids: string[];
  rows: RawRow[];
  expected: string | null;
  error?: string;
};

const ID = `0x${'01'.repeat(32)}`;
const ISM = `0x${'02'.repeat(32)}`;

// mulberry32: deterministic across Node versions.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(rows: RawRow[], ids: string[]) {
  const parsed = rows.map(({ activity_text, ...rest }) => ({
    ...rest,
    activity: JSON.parse(activity_text),
  }));
  const service = new DiagnosticsService({ query: async () => parsed });
  try {
    return { expected: JSON.stringify(await service.snapshots(ids)) };
  } catch (error) {
    const code =
      error instanceof GraphQLError ? error.extensions.code : undefined;
    return {
      expected: null,
      error: typeof code === 'string' ? code : String(error),
    };
  }
}

// ---- hand-written cases mirroring diagnostics.test.ts ----
function rowOf(
  activity: unknown,
  number = 1,
  relayer = 'relayer-a',
  extra: Partial<RawRow> = {},
): RawRow {
  return {
    id: String(number),
    message_id: ID,
    relayer,
    origin: 1,
    destination: 2,
    observed_at: `2026-11-05 00:00:${String(number % 60).padStart(2, '0')}+00`,
    received_at: '2026-11-05 00:00:01+00',
    version: 1,
    activity_text: JSON.stringify(activity),
    ...extra,
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
    ism: ISM,
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

const handWritten: [string, RawRow[]][] = [
  [
    'threshold progress',
    [
      rowOf({
        type: 'validator_set',
        ism: ISM,
        validators: ['a', 'b', 'c', 'd'],
        threshold: 3,
      }),
      rowOf(signature(2), 2),
      rowOf(
        {
          type: 'retry',
          reason: 'AwaitingValidatorSignatures',
          retry_count: 1,
          next_attempt_at_millis: 123,
        },
        3,
      ),
      rowOf(signature(1, 'a', 'other-root'), 4),
      rowOf(signature(1), 5, 'relayer-b'),
      rowOf({ type: 'metadata_started', ism: ISM }, 6),
    ],
  ],
  [
    'aggregation',
    [
      rowOf({
        type: 'aggregation',
        ism: ISM,
        modules: ['a', 'b', 'c'],
        threshold: 2,
      }),
      rowOf(
        { type: 'aggregation_progress', ism: ISM, verified: 1, threshold: 2 },
        2,
      ),
      rowOf({ type: 'ism_verification', ism: 'a', outcome: 'succeeded' }, 3),
      rowOf({ type: 'metadata', ism: ISM, error: null }, 4),
      rowOf({ type: 'future_event' }, 5),
      rowOf({ type: 'delivered' }, 6, 'relayer-a', { version: 2 }),
    ],
  ],
  [
    'legacy failure/retry key order',
    [
      rowOf({ type: 'chain_failure', stage: 'prepare', reason: 'rpc_error' }),
      rowOf(
        {
          type: 'retry',
          reason: 'ErrorBuildingMetadata',
          retry_count: 2,
          next_attempt_at_millis: 100,
        },
        2,
      ),
      rowOf({ type: 'metadata_started', ism: ISM }, 3),
      rowOf({ type: 'chain_failure', stage: 'simulate', reason: 'x' }, 4),
      rowOf(
        {
          type: 'retry',
          reason: { ApplicationReport: 'ZeroAmount' },
          retry_count: 4294967295,
          next_attempt_at_millis: 1793868325894,
        },
        5,
      ),
    ],
  ],
  [
    'checkpoint observations',
    [
      rowOf({
        type: 'metadata_module',
        ism: ISM,
        module_type: 'MessageIdMultisig',
      }),
      rowOf(
        {
          type: 'validator_set',
          ism: ISM,
          validators: ['a', 'b', 'c'],
          threshold: 3,
        },
        2,
      ),
      rowOf(signature(2, 'a', 'root', 4294967295), 3),
      rowOf(
        {
          type: 'checkpoint',
          ism: ISM,
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
      rowOf(
        { type: 'ism_verification', ism: ISM, outcome: 'future_outcome' },
        5,
      ),
      rowOf(
        {
          type: 'offchain_read',
          ism: ISM,
          state: 'pending',
          attempt: 1,
          endpoint: null,
          http_status: 202,
        },
        6,
      ),
      rowOf(
        {
          type: 'checkpoint',
          ism: null,
          collection_id: 'z',
          threshold: 2,
          observation: { type: 'fetching', index: 7 },
        },
        7,
      ),
      rowOf(
        {
          type: 'checkpoint',
          ism: null,
          collection_id: 'z',
          threshold: 2,
          observation: {
            type: 'signature',
            index: 7,
            root: 'r',
            collected: 1,
            validator: 'v',
          },
        },
        8,
      ),
      rowOf(
        {
          type: 'checkpoint',
          ism: null,
          collection_id: 'z',
          threshold: 2,
          observation: {
            type: 'unavailable',
            index: null,
            validator: 'v',
            reason: 'fetch_error',
          },
        },
        9,
      ),
      rowOf(
        {
          type: 'checkpoint',
          ism: null,
          collection_id: 'z',
          threshold: 2,
          observation: {
            type: 'unavailable',
            index: 7,
            validator: 'w',
            reason: 'x',
          },
        },
        10,
      ),
      rowOf(
        {
          type: 'checkpoint',
          ism: null,
          collection_id: 'y',
          threshold: 2,
          observation: { type: 'latest_index' },
        },
        11,
      ),
    ],
  ],
  [
    'snapshot anchors and updates',
    [
      rowOf({
        type: 'snapshot',
        state: {
          phase: 'preparing',
          tree_root: 'root',
          modules: [
            { node_id: 'root', ism: ISM, children: [] },
            { node_id: 'other', ism: 'other-ism', children: [] },
          ],
        },
      }),
      rowOf(
        {
          type: 'snapshot_update',
          state: {
            phase: 'awaiting_signatures',
            tree_root: 'root',
            modules: [{ node_id: 'root', ism: ISM, children: [], verified: 1 }],
            removed_modules: ['other'],
            retry: {
              reason: 'AwaitingValidatorSignatures',
              count: 1,
              next_attempt_at_millis: 123,
            },
          },
        },
        2,
      ),
      rowOf(
        {
          type: 'snapshot_update',
          state: {
            phase: 'delivered',
            tree_root: 'root',
            modules: [],
            removed_modules: [],
            retry: null,
          },
        },
        3,
      ),
      rowOf(
        {
          type: 'snapshot',
          state: { phase: 'delivered', tree_root: null, modules: [] },
        },
        4,
        'relayer-b',
      ),
      rowOf(
        {
          type: 'snapshot_update',
          state: {
            phase: 'retrying',
            tree_root: 'x',
            modules: [],
            removed_modules: [],
          },
        },
        5,
        'relayer-c',
      ),
    ],
  ],
  [
    'producer snapshot counters',
    [
      rowOf({
        type: 'snapshot',
        state: {
          phase: 'awaiting_signatures',
          tree_root: 'root',
          modules: [
            {
              node_id: 'root',
              ism: ISM,
              children: [],
              selected_children: [],
              signatures: {
                index: 3,
                root: 'checkpoint-root',
                collected: 1,
                signers: [
                  {
                    validator: 'validator-a',
                    location: 's3://validator-bucket/us-east-1/checkpoints',
                  },
                ],
                threshold: 2,
                unavailable: [],
              },
              offchain_read: {
                state: 'pending',
                endpoint: 0,
                http_status: 202,
              },
            },
          ],
        },
      }),
      rowOf({ type: 'metadata_module', ism: ISM, module_type: 'X' }, 2),
      rowOf(
        { type: 'validator_set', ism: 'other', validators: [], threshold: 0 },
        3,
      ),
    ],
  ],
  [
    'snapshot then legacy mutation',
    [
      rowOf({
        type: 'snapshot',
        state: {
          phase: 'preparing',
          tree_root: 'root',
          extra: { b: 1, 2: 'x' },
          relayer: 'spoof',
          modules: [
            {
              node_id: 'n',
              ism: ISM,
              modules: ['spoof'],
              observed_at: 'spoof',
              signatures: null,
              x: 1,
            },
          ],
        },
      }),
      rowOf(
        {
          type: 'checkpoint',
          ism: ISM,
          collection_id: 'c',
          threshold: 1,
          observation: {
            type: 'signature',
            index: 2,
            root: 'r',
            collected: 1,
            validator: 'v',
          },
        },
        2,
      ),
      rowOf({ type: 'chain_failure', stage: 's', reason: 'r' }, 3),
      rowOf(
        { type: 'status', status: { Retry: 'AwaitingValidatorSignatures' } },
        4,
      ),
      rowOf(
        {
          type: 'retry',
          reason: 'AwaitingValidatorSignatures',
          retry_count: 1,
          next_attempt_at_millis: null,
        },
        5,
      ),
    ],
  ],
];

// ---- generated histories ----
function generate(seed: number): RawRow[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => {
    const value = xs[Math.floor(r() * xs.length)];
    if (value === undefined) throw new Error('empty choice list');
    return value;
  };
  const chance = (p: number) => r() < p;
  const isms = [ISM, 'ism-b', 'unknown', 'a'];
  const nodes = ['root', 'root/0', 'root/1', 'root/0/0'];
  const relayers = ['0xaa', '0xbb', '0xcc'].slice(0, 1 + Math.floor(r() * 3));
  const reasons = [
    'AwaitingValidatorSignatures',
    'ErrorBuildingMetadata',
    { ApplicationReport: 'ZeroAmount' },
    { a: 1 },
    { a: 'x', b: 'y' },
    {},
    null,
    7,
    ['x'],
  ];
  const phases = [
    'unknown',
    'preparing',
    'ready_to_submit',
    'awaiting_signatures',
    'retrying',
    'submitting',
    'confirming',
    'delivered',
    'dropped',
    'bogus',
  ];
  const counts = [
    0,
    1,
    2,
    3,
    4294967295,
    1793868325894,
    -1,
    1.5,
    2 ** 53,
    '3',
    null,
  ];
  const goodCount = () =>
    chance(0.9) ? pick([0, 1, 2, 3, 4294967295]) : pick(counts);
  const extras = () => {
    const out: Record<string, unknown> = {};
    if (chance(0.15))
      out[
        pick([
          'x',
          '10',
          '0',
          'relayer',
          'observed_at',
          'modules',
          'signatures',
          'zz',
          'é',
        ])
      ] = pick([1, 1.5, 1e21, -0, 'str', null, { k: [1, 'a'] }, true, 1e-7]);
    return out;
  };
  const mutate = (event: Record<string, unknown>) => {
    if (!chance(0.12)) return event;
    const keys = Object.keys(event).filter((k) => k !== 'type');
    if (!keys.length) return event;
    const key = pick(keys);
    const mode = Math.floor(r() * 4);
    if (mode === 0) delete event[key];
    else if (mode === 1) event[key] = null;
    else if (mode === 2)
      event[key] = typeof event[key] === 'string' ? 5 : 'str';
    else event[key] = pick(counts);
    return event;
  };
  const signatures = () => {
    const s: Record<string, unknown> = {};
    if (chance(0.4)) s.collection_id = pick(['a', null]);
    if (chance(0.7)) s.index = pick([1, 2, null]);
    if (chance(0.7)) s.root = pick(['r', null]);
    if (chance(0.7)) s.collected = pick([0, 1, null]);
    if (chance(0.5))
      s.signers = chance(0.5)
        ? []
        : [
            {
              validator: 'v',
              ...(chance(0.5) ? { location: pick(['loc', null]) } : {}),
            },
          ];
    s.threshold = goodCount();
    s.unavailable = chance(0.5)
      ? []
      : [{ validator: 'v', reason: 'no_storage' }];
    if (chance(0.1)) s.extra = 1;
    return chance(0.05) ? mutate(s) : s;
  };
  const module = () => {
    const m: Record<string, unknown> = {
      node_id: pick(nodes),
      ism: pick(isms),
    };
    if (chance(0.3)) m.module_type = pick(['MessageIdMultisig', null]);
    if (chance(0.3)) m.validators = pick([['a', 'b'], [], null]);
    if (chance(0.3)) m.threshold = pick([1, 2, null]);
    if (chance(0.6))
      m.children = chance(0.5)
        ? []
        : [{ node_id: pick(nodes), ism: pick(isms) }];
    if (chance(0.3)) m.selected_children = pick([[], ['root/0']]);
    if (chance(0.3)) m.verified = pick([0, 1, null]);
    if (chance(0.3))
      m.verification = pick(['succeeded', 'started', 'weird', null]);
    if (chance(0.3)) m.metadata_error = pick(['err', null]);
    if (chance(0.4)) m.signatures = chance(0.2) ? null : signatures();
    if (chance(0.3))
      m.offchain_read = chance(0.2)
        ? null
        : {
            state: 'pending',
            ...(chance(0.5) ? { attempt: pick([1, null]) } : {}),
            endpoint: pick([0, null]),
            http_status: pick([202, null]),
          };
    Object.assign(m, extras());
    return chance(0.04) ? mutate(m) : m;
  };
  const state = (update: boolean) => {
    const s: Record<string, unknown> = {
      phase: pick(phases),
      tree_root: pick(['root', null]),
      modules: Array.from({ length: Math.floor(r() * 3) }, module),
    };
    if (chance(0.3))
      s.failure = chance(0.3) ? null : { stage: 'prepare', reason: 'rpc' };
    if (chance(0.3))
      s.retry = chance(0.3)
        ? null
        : {
            reason: 'AwaitingValidatorSignatures',
            count: goodCount(),
            next_attempt_at_millis: pick([null, 123]),
          };
    if (update) s.removed_modules = chance(0.5) ? [] : [pick(nodes)];
    Object.assign(s, extras());
    return chance(0.04) ? mutate(s) : s;
  };
  const events: (() => Record<string, unknown>)[] = [
    () => ({ type: 'snapshot', state: state(false) }),
    () => ({ type: 'snapshot_update', state: state(true) }),
    () => ({
      type: 'chain_failure',
      stage: pick(['prepare', 'simulate']),
      reason: 'rpc_error',
    }),
    () => ({
      type: 'offchain_read',
      ism: pick(isms),
      state: 'pending',
      attempt: goodCount(),
      endpoint: pick([0, null]),
      http_status: pick([202, null]),
    }),
    () => ({
      type: 'status',
      status: pick([
        'ReadyToSubmit',
        'FirstPrepareAttempt',
        'Other',
        { Confirm: pick(reasons) },
        { Retry: pick(reasons) },
        { Confirm: 'a', Retry: 'b' },
        { Neither: 1 },
      ]),
    }),
    () => ({ type: 'metadata_started', ism: pick(isms) }),
    () => ({
      type: 'metadata_module',
      ism: pick(isms),
      module_type: 'MessageIdMultisig',
    }),
    () => ({
      type: 'validator_set',
      ism: pick([...isms, null]),
      validators: pick([['a', 'b', 'c'], []]),
      threshold: goodCount(),
    }),
    () => ({ type: 'routing', ism: pick(isms), module: pick(isms) }),
    () => ({
      type: 'aggregation',
      ism: pick(isms),
      modules: [pick(isms)],
      threshold: goodCount(),
    }),
    () => ({
      type: 'aggregation_progress',
      ism: pick(isms),
      verified: goodCount(),
      threshold: goodCount(),
    }),
    () => ({
      type: 'ism_verification',
      ism: pick(isms),
      outcome: pick(['succeeded', 'failed', 'no_estimate', 'future']),
    }),
    () => ({ type: 'metadata', ism: pick(isms), error: pick([null, 'err']) }),
    () => {
      const e: Record<string, unknown> = {
        type: 'checkpoint',
        ism: pick([...isms, null]),
        collection_id: pick(['a', 'b']),
        threshold: goodCount(),
      };
      if (chance(0.4)) {
        const unavailable: Record<string, string> = {};
        if (chance(0.5)) unavailable[pick(['v', 'w', '5', '1'])] = 'no_storage';
        if (chance(0.3)) unavailable[pick(['x', '0'])] = 'missing';
        e.summary = {
          index: pick([1, 2, null]),
          root: pick(['r', 'q', null]),
          collected: goodCount(),
          unavailable,
          attempts: 1,
        };
      }
      if (chance(0.8))
        e.observation = pick([
          { type: 'fetching', index: pick([1, 2]) },
          {
            type: 'signature',
            index: pick([1, 2]),
            root: pick(['r', 'q']),
            collected: goodCount(),
            validator: pick(['v', 'w']),
          },
          {
            type: 'unavailable',
            index: pick([1, 2, null]),
            validator: pick(['v', 'w']),
            reason: 'missing',
          },
          { type: 'latest_index' },
          { type: 'mystery' },
        ]);
      return e;
    },
    () => ({
      type: 'retry',
      reason: pick(reasons),
      retry_count: goodCount(),
      next_attempt_at_millis: pick([null, 123, 1793868325894]),
    }),
    () => ({
      type: 'progress',
      stage: pick(['prepare', 'submit', 'confirm', 'other']),
      outcome: pick(['started', 'finished']),
    }),
    () => ({ type: 'delivered' }),
    () => ({ type: 'dropped' }),
    () => ({ type: 'filtered', reason: 'runtime_denylisted' }),
    () => ({ type: 'retry_limit_reached', retries: 3, limit: 3 }),
    () => ({ type: 'future_event', x: 1 }),
  ];
  const length = chance(0.04)
    ? 95 + Math.floor(r() * 30)
    : 1 + Math.floor(r() * 14);
  let id = chance(0.2) ? 95 + Math.floor(r() * 10) : 1;
  const rows: RawRow[] = [];
  for (let i = 0; i < length; i++) {
    id += chance(0.8) ? 1 : 1 + Math.floor(r() * 20);
    const event = mutate({ ...pick(events)() });
    Object.assign(event, chance(0.2) ? extras() : {});
    let text = JSON.stringify(event);
    // PostgreSQL jsonb output spacing; key order is whatever we emit, so
    // integer-like keys hoisted by JSON.parse are exercised.
    if (chance(0.5)) text = text.replace(/":/g, '": ').replace(/,"/g, ', "');
    if (chance(0.05)) text = `{"5": 1, ${text.slice(1)}`;
    rows.push({
      id: String(id),
      message_id: ID,
      relayer: pick(relayers),
      origin: chance(0.8) ? 1 : pick(['1', '42', ' 7 ', '']),
      destination: 2,
      observed_at: `2026-11-05 00:${String(i % 60).padStart(2, '0')}:00+00`,
      received_at: '2026-11-05 00:00:01+00',
      version: chance(0.97) ? 1 : 2,
      activity_text: text,
    });
  }
  // The production query returns rows by id descending.
  return rows.reverse();
}

async function main() {
  const cases: Case[] = [];
  for (const [name, rows] of handWritten) {
    const ordered = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
    cases.push({
      name,
      ids: [ID],
      rows: ordered,
      ...(await run(ordered, [ID])),
    });
  }
  // diagnostics.test.ts selection scenarios, rows in production (id DESC) order.
  {
    const state = { phase: 'preparing', tree_root: null, modules: [] };
    const interleaved: RawRow[] = [];
    for (let index = 0; index < 51; index++) {
      const reporter = `relayer-${index}`;
      interleaved.push(rowOf({ type: 'snapshot', state }, index + 1, reporter));
      interleaved.push(
        rowOf(
          {
            type: 'snapshot_update',
            state: { ...state, phase: 'delivered', removed_modules: [] },
          },
          index + 52,
          reporter,
        ),
      );
    }
    const legacy: RawRow[] = [
      rowOf({ type: 'snapshot', state }, 1, 'older-reporter'),
      rowOf(
        {
          type: 'snapshot_update',
          state: { ...state, phase: 'ready_to_submit', removed_modules: [] },
        },
        2,
        'older-reporter',
      ),
      rowOf({ type: 'delivered' }, 3, 'older-reporter'),
    ];
    for (let index = 0; index < 49; index++) {
      const reporter = `relayer-${index}`;
      legacy.push(rowOf({ type: 'snapshot', state }, 4 + index * 2, reporter));
      legacy.push(
        rowOf(
          {
            type: 'snapshot_update',
            state: { ...state, phase: 'delivered', removed_modules: [] },
          },
          5 + index * 2,
          reporter,
        ),
      );
    }
    const progress = Array.from({ length: 101 }, (_, i) =>
      rowOf(
        { type: 'progress', stage: 'prepare', outcome: 'started' },
        101 - i,
      ),
    );
    const selection: [string, RawRow[]][] = [
      ['interleaved reporters truncate as groups', interleaved],
      ['legacy newest event does not fit', legacy],
      ['101 progress rows are partial', progress],
    ];
    for (const [name, rows] of selection) {
      const ordered = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
      cases.push({
        name,
        ids: [ID],
        rows: ordered,
        ...(await run(ordered, [ID])),
      });
    }
    // Batches normalize, dedupe and keep request order; rows filter by ID.
    const other = `0x${'ab'.repeat(32)}`;
    const mixed = [
      rowOf({ type: 'delivered' }, 3, 'relayer-a', { message_id: other }),
      rowOf({ type: 'dropped' }, 2),
      rowOf(
        {
          type: 'retry',
          reason: 'X',
          retry_count: 1,
          next_attempt_at_millis: null,
        },
        1,
        'relayer-b',
        { message_id: other },
      ),
    ];
    const ids = [
      `0x${'AB'.repeat(32)}`,
      `\\x${'01'.repeat(32)}`,
      other,
      `${'cd'.repeat(32)}`,
    ];
    cases.push({
      name: 'multi-id batch',
      ids,
      rows: mixed,
      ...(await run(mixed, ids)),
    });
    // A digit-boundary ID set sorts numerically, not lexically.
    const boundary = [
      rowOf({ type: 'dropped' }, 100),
      rowOf({ type: 'delivered' }, 99),
      rowOf({ type: 'delivered' }, 10),
    ];
    cases.push({
      name: 'numeric id order',
      ids: [ID],
      rows: boundary,
      ...(await run(boundary, [ID])),
    });
    const invalid: [string, string[]][] = [
      ['invalid id', ['nope']],
      ['empty batch', []],
      ['oversized batch', Array.from({ length: 21 }, () => ID)],
      ['uppercase prefix rejected', [`0X${'01'.repeat(32)}`]],
    ];
    for (const [name, bad] of invalid) {
      cases.push({ name, ids: bad, rows: [], ...(await run([], bad)) });
    }
  }
  // Rows rejected by the activity row schema make the read unavailable.
  const malformed: [string, Partial<RawRow>][] = [
    ['bad id', { id: 'x1' }],
    ['array activity', { activity_text: '[1]' }],
    ['null activity', { activity_text: 'null' }],
    ['NaN origin', { origin: 'abc' }],
    ['string version', { version: '1' }],
  ];
  for (const [name, patch] of malformed) {
    const rows = [{ ...rowOf({ type: 'delivered' }), ...patch }];
    cases.push({ name, ids: [ID], rows, ...(await run(rows, [ID])) });
  }
  // The committed corpus keeps 60 seeds (<1 MB); DIAGNOSTICS_CORPUS_SEEDS=600
  // regenerates the full set used for release checks.
  const seeds = Number(process.env.DIAGNOSTICS_CORPUS_SEEDS ?? 60);
  for (let seed = 1; seed <= seeds; seed++) {
    const rows = generate(seed);
    cases.push({
      name: `seed ${seed}`,
      ids: [ID],
      rows,
      ...(await run(rows, [ID])),
    });
  }
  const out = join(
    dirname(fileURLToPath(import.meta.url)),
    'reducer-corpus.json',
  );
  writeFileSync(out, JSON.stringify(cases));
  process.stdout.write(`wrote ${cases.length} cases to ${out}\n`);
}

await main();
