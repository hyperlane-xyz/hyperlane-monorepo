// Dumps the TS SQL builder outputs for a fixed corpus so the Zig port can
// assert byte-identical SQL and identical parameter values.
// Run from the repository root:
//   pnpm -C zig/scraper-proxy exec tsx src/scraperdb/testdata/gen-corpus.ts > zig/scraper-proxy/src/scraperdb/testdata/corpus.json
import {
  buildProvisionalMessageAffectedQuery,
  PROJECTED_MESSAGE_QUERY,
  PROVISIONAL_MESSAGE_QUERY,
} from '../../../../../typescript/scraper-proxy/src/live/provisional-message.js';
import {
  type MessageSelectArgs,
  ScraperDbService,
} from '../../../../../typescript/scraper-proxy/src/scraperdb/scraperdb.service.js';
import {
  buildByPk,
  buildCount,
  buildSelect,
  type CountArgs,
  type SelectArgs,
} from '../../../../../typescript/scraper-proxy/src/scraperdb/sql.js';
import {
  tables,
  type TableName,
} from '../../../../../typescript/scraper-proxy/src/scraperdb/tables.js';

type Args = Record<string, unknown>;
type Case =
  | {
      kind: 'select';
      table: TableName;
      args?: SelectArgs;
      source?: { relation: string; values: unknown[] };
    }
  | { kind: 'count'; table: TableName; args?: SelectArgs; count?: CountArgs }
  | { kind: 'byPk'; table: TableName; id: unknown; columns?: string[] }
  | {
      kind: 'messages';
      args: MessageSelectArgs;
      snapshot?: Record<string, unknown> | null;
    };

const eq = (value: unknown) => ({ _eq: value });
const many = (n: number, item: unknown) =>
  Array.from({ length: n }, () => item);
function nest(depth: number, inner: Args): Args {
  let out = inner;
  for (let i = 0; i < depth; i++) out = { _not: out };
  return out;
}

const selects: [TableName, SelectArgs?][] = [
  ['domain'],
  ['domain', {}],
  ['message_view'],
  ['raw_message_dispatch'],
  [
    'domain',
    {
      columns: ['id', 'name', 'unknown'],
      limit: 5,
      offset: 2,
      order_by: { id: 'desc_nulls_first' },
      where: { _or: [{ id: { _gte: 1 } }, { name: { _eq: 'ethereum' } }] },
    },
  ],
  ['domain', { columns: ['name', 'name', 'id', '__typename'] }],
  ['domain', { columns: ['nope'] }],
  ['domain', { columns: [] }],
  ['message_view', { columns: ['nope'] }],
  ['message_view', { columns: ['is_provisional', 'id'] }],
  [
    'raw_message_dispatch',
    { columns: ['msg_id'], where: { origin_domain: eq(1) } },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { id: 10 }, ordering: 'DESC' }] },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { id: '10' }, ordering: 'ASC' }] },
  ],
  ['message_view', { cursor: [{ initial_value: { id: '10' } }] }],
  [
    'message_view',
    {
      cursor: [{ initial_value: { id: 1 }, ordering: 'ASC' }],
      order_by: { id: 'asc' },
    },
  ],
  [
    'message_view',
    {
      cursor: [{ initial_value: { id: 1 }, ordering: 'DESC' }],
      order_by: { id: 'desc_nulls_last' },
      limit: 50,
    },
  ],
  [
    'message_view',
    {
      cursor: [{ initial_value: { id: 1 }, ordering: 'DESC' }],
      order_by: { id: 'asc' },
    },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { id: 1 } }], order_by: { id: 'desc' } },
  ],
  [
    'message_view',
    {
      cursor: [{ initial_value: { id: 1 } }],
      order_by: [{ id: 'asc' }, { nonce: 'asc' }],
    },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { id: 1 } }], order_by: { nonce: 'asc' } },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { id: 1 } }, { initial_value: { id: 2 } }] },
  ],
  [
    'message_view',
    { cursor: [{ initial_value: { send_occurred_at: '2026-01-01', id: 1 } }] },
  ],
  ['message_view', { cursor: [{ initial_value: {} }] }],
  [
    'message_view',
    { cursor: [{ initial_value: { origin_domain: 'ethereum' } }] },
  ],
  ['message_view', { cursor: [{ initial_value: { id: null } }] }],
  ['message_view', { cursor: [] }],
  ['domain', { cursor: [{ initial_value: { id: 1 } }] }],
  [
    'message_view',
    { distinct_on: ['origin_domain'], order_by: { nonce: 'desc' } },
  ],
  [
    'message_view',
    {
      distinct_on: ['origin_domain'],
      order_by: [{ origin_domain: 'asc' }, { nonce: 'desc' }],
    },
  ],
  [
    'message_view',
    {
      distinct_on: ['origin_domain', 'nonce'],
      order_by: [{ origin_domain: 'asc' }, { nonce: 'desc' }],
    },
  ],
  [
    'message_view',
    {
      distinct_on: ['origin_domain', 'nonce'],
      order_by: [{ origin_domain: 'asc' }],
    },
  ],
  ['message_view', { distinct_on: ['origin_domain'] }],
  [
    'message_view',
    { distinct_on: ['origin_domain'], cursor: [{ initial_value: { id: 1 } }] },
  ],
  [
    'message_view',
    {
      distinct_on: ['origin_domain'],
      cursor: [{ initial_value: { id: 1 } }],
      order_by: { id: null },
    },
  ],
  [
    'message_view',
    { distinct_on: ['id'], cursor: [{ initial_value: { id: 1 } }] },
  ],
  ['message_view', { distinct_on: ['a', 'b', 'c', 'd'] }],
  ['message_view', { distinct_on: ['nope'] }],
  ['message_view', { distinct_on: [] }],
  ['message_view', { distinct_on: null }],
  [
    'message_view',
    { order_by: [{ id: 'asc', nonce: 'desc' }, { sender: 'asc_nulls_first' }] },
  ],
  [
    'message_view',
    {
      order_by: [
        { id: 'asc', nonce: 'desc' },
        { sender: 'asc_nulls_first', recipient: 'desc' },
      ],
    },
  ],
  [
    'message_view',
    {
      order_by: [
        { id: 'asc', nonce: null },
        { sender: null },
        { recipient: 'asc_nulls_last' },
        {},
      ],
    },
  ],
  ['message_view', { order_by: { nope: 'asc' } }],
  ['message_view', { order_by: { nope: 'asc' }, where: { nope2: eq(1) } }],
  ['message_view', { order_by: { nope: 'asc' }, distinct_on: ['nope'] }],
  ['message_view', { order_by: { nope: 'asc' }, distinct_on: ['nope3'] }],
  ['message_view', { order_by: [] }],
  ['message_view', { order_by: null }],
  ['domain', { order_by: { id: 'asc' } }],
  ['domain', { order_by: { id: 'asc_nulls_last' } }],
  ['domain', { order_by: { id: 'desc' } }],
  ['domain', { order_by: { id: 'desc_nulls_last' } }],
  ['domain', { order_by: { id: 'asc_nulls_first' } }],
  ['domain', { limit: 501 }],
  ['domain', { limit: 500 }],
  ['domain', { limit: 0 }],
  ['domain', { limit: -1 }],
  ['domain', { limit: 1.5 }],
  ['domain', { offset: 5000 }],
  ['domain', { offset: 5001 }],
  ['domain', { offset: -3 }],
  ['domain', { offset: 0 }],
  ['domain', { limit: null, offset: null, order_by: { id: null } }],
  ['domain', { limit: 501, offset: -1 }],
  ['domain', { offset: -1, distinct_on: ['a', 'b', 'c', 'd'] }],
  [
    'domain',
    {
      distinct_on: ['a', 'b', 'c', 'd'],
      order_by: [
        { id: 'asc' },
        { name: 'asc' },
        { chain_id: 'asc' },
        { is_test_net: 'asc' },
      ],
    },
  ],
  [
    'domain',
    {
      order_by: [
        { id: 'asc' },
        { name: 'asc' },
        { chain_id: 'asc' },
        { is_test_net: 'asc' },
      ],
    },
  ],
  [
    'domain',
    { order_by: [{ id: 'asc' }, { name: 'asc' }, { chain_id: 'asc' }] },
  ],
  ['domain', { where: { id: { _in: many(201, 1) } } }],
  ['domain', { where: { id: { _in: many(200, 1) } } }],
  ['domain', { where: { id: { _nin: many(201, 1) } } }],
  ['domain', { where: { id: { _contains: 'x' } } }],
  ['domain', { where: { name: { _like: 'eth%' } } }],
  ['domain', { where: { name: { _ilike: 'eth%' } } }],
  ['domain', { where: { name: { _regex: 'eth%' } } }],
  ['domain', { where: { name: { _similar: 'eth%' } } }],
  ['domain', { where: { name: { _like: null } } }],
  ['domain', { where: nest(8, { id: eq(1) }) }],
  ['domain', { where: nest(9, { id: eq(1) }) }],
  ['domain', { where: nest(9, {}) }],
  ['domain', { where: { _and: many(50, { id: eq(1) }) } }],
  ['domain', { where: { _and: many(99, { id: eq(1) }) } }],
  ['domain', { where: { _and: many(100, { id: eq(1) }) } }],
  ['domain', { where: { _or: [{}, ...many(50, { id: eq(1) })] } }],
  ['domain', { where: { _or: [{}, ...many(49, { id: eq(1) })] } }],
  ['domain', { where: { _or: [] } }],
  ['domain', { where: { _and: [] } }],
  ['domain', { where: { _or: [{ id: eq(1) }, {}] } }],
  ['domain', { where: { _or: [{ id: eq(1) }, {}], name: eq('x') } }],
  ['domain', { where: { _or: [{ id: eq(1) }, null] } }],
  ['domain', { where: { _and: [{ id: eq(1) }, null, {}] } }],
  ['domain', { where: { _or: { id: eq(1) } } }],
  ['domain', { where: { _and: { id: eq(1) } } }],
  ['domain', { where: { _or: {} } }],
  ['domain', { where: { _not: {} } }],
  ['domain', { where: { _not: null } }],
  ['domain', { where: { _not: { _or: [] } } }],
  [
    'domain',
    { where: { _not: { _and: [{ id: eq(2) }, { name: { _neq: 'a' } }] } } },
  ],
  ['domain', { where: { id: { _is_null: null } } }],
  ['domain', { where: { id: { _is_null: true } } }],
  ['domain', { where: { id: { _is_null: false } } }],
  ['domain', { where: { id: { _is_null: 0 } } }],
  ['domain', { where: { id: { _is_null: '' } } }],
  ['domain', { where: { id: { _is_null: 'x' } } }],
  ['domain', { where: { id: { _in: [1, 2, 3], _nin: [4, 5] } } }],
  ['domain', { where: { id: { _in: [], _nin: [] } } }],
  ['domain', { where: { id: { _in: 'notarray' } } }],
  [
    'domain',
    {
      where: {
        id: {
          _eq: 1,
          _gt: '2',
          _gte: 3,
          _lt: 4.5,
          _lte: -5,
          _neq: true,
          _in: ['6'],
          _nin: [7],
          _is_null: false,
        },
      },
    },
  ],
  ['domain', { where: { id: null, name: eq('a') } }],
  ['domain', { where: { id: 5 } }],
  ['domain', { where: { id: {} } }],
  ['domain', { where: { nope: eq(1) } }],
  ['domain', { where: { nope: null } }],
  ['domain', { where: null }],
  ['domain', { where: {} }],
  [
    'domain',
    {
      where: {
        _and: [
          { _or: [{ id: eq(1) }, { id: eq(2) }] },
          { _or: [{ name: eq('a') }, {}] },
          { chain_id: eq('3') },
        ],
      },
    },
  ],
  [
    'domain',
    {
      where: {
        _or: [
          { _and: [{ id: eq(1) }, { name: eq('b') }] },
          { _or: [{ chain_id: eq(9) }, {}] },
        ],
        id: eq(4),
      },
    },
  ],
  ['domain', { where: { _or: [{ id: eq(1) }, { _not: {} }] } }],
  ['domain', { where: { _or: [{ id: eq(1) }, { _not: { id: null } }] } }],
  ['domain', { where: { _or: [{ id: { _in: [] } }, { id: { _nin: [] } }] } }],
  [
    'message_view',
    {
      where: {
        is_provisional: eq(true),
        msg_id: eq('\\x01'),
        origin_domain_id: { _in: [1, 2] },
      },
      order_by: [{ send_occurred_at: 'desc' }, { id: 'desc' }],
      limit: 10,
    },
  ],
  ['message_view', { where: { 'we"ird': eq(1) } }],
  [
    'message_view',
    { columns: ['id'], where: { message_body: eq({ nested: [1, 'x'] }) } },
  ],
  [
    'message_view',
    { where: { msg_id: { _in: [['\\x01', null], ['\\x02']] } } },
  ],
];

const cases: Case[] = [
  ...selects.map(([table, args]): Case => ({ kind: 'select', table, args })),
  {
    kind: 'select',
    table: 'message_view',
    args: { limit: 5, where: { origin_domain_id: { _eq: 1 } } },
    source: { relation: 'provisional_message_view', values: [0] },
  },
  {
    kind: 'select',
    table: 'message_view',
    args: { where: { id: eq(3) } },
    source: {
      relation: 'canonical_message_view',
      values: [['\\x01'], [1], ['5']],
    },
  },
  {
    kind: 'select',
    table: 'domain',
    source: { relation: 'we"ird', values: [] },
  },
  {
    kind: 'select',
    table: 'domain',
    args: { limit: 3 },
    source: { relation: '', values: [7] },
  },
  { kind: 'count', table: 'raw_message_dispatch' },
  { kind: 'count', table: 'domain', args: { where: { id: eq(1) } } },
  {
    kind: 'count',
    table: 'message_view',
    args: { distinct_on: ['origin_domain'], limit: 2, offset: 1 },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: ['origin_domain'], distinct: true },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: ['origin_domain'], distinct: false },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: ['origin_domain'], distinct: null },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: [], distinct: true },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: null, distinct: true },
  },
  {
    kind: 'count',
    table: 'message_view',
    count: { columns: ['origin_domain', 'origin_domain', 'nonce'] },
  },
  { kind: 'count', table: 'message_view', count: { columns: ['nope'] } },
  {
    kind: 'count',
    table: 'message_view',
    args: { limit: 501 },
    count: { columns: ['nope'] },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { distinct_on: ['nope'] },
    count: { columns: ['nope2'] },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { distinct_on: ['nope'], where: { nope3: eq(1) } },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { limit: 10, order_by: { nonce: 'desc' } },
    count: { columns: ['origin_domain', 'destination_domain'], distinct: true },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { order_by: { nonce: 'desc' } },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { order_by: { nope: 'desc' } },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { order_by: { nope: 'desc' }, offset: 0 },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: {
      distinct_on: ['nonce'],
      order_by: [{ nonce: 'desc' }, { id: 'asc' }],
      where: { _or: [{ id: eq(1) }, { sender: { _is_null: true } }] },
      limit: 3,
      offset: 4,
    },
    count: { columns: ['sender'] },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: {
      cursor: [{ initial_value: { id: 4 }, ordering: 'DESC' }],
      limit: 2,
    },
  },
  {
    kind: 'count',
    table: 'message_view',
    args: { cursor: [{ initial_value: { id: 4 } }] },
  },
  { kind: 'byPk', table: 'domain', id: 1, columns: ['name'] },
  { kind: 'byPk', table: 'domain', id: 1 },
  { kind: 'byPk', table: 'domain', id: '1', columns: ['nope'] },
  { kind: 'byPk', table: 'domain', id: 1, columns: [] },
  {
    kind: 'byPk',
    table: 'raw_message_dispatch',
    id: '99',
    columns: ['msg_id', 'id', 'msg_id'],
  },
  { kind: 'byPk', table: 'message_view', id: 1 },
  { kind: 'messages', args: {} },
  { kind: 'messages', args: { confirmations: null, limit: 2 } },
  { kind: 'messages', args: { confirmations: -1 } },
  { kind: 'messages', args: { confirmations: 1.5 } },
  { kind: 'messages', args: { confirmations: 1001 } },
  { kind: 'messages', args: { confirmations: 2_147_483_647 } },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      cursor: [{ initial_value: { id: 2 }, ordering: 'DESC' }],
    },
  },
  { kind: 'messages', args: { confirmations: 0, offset: 1 } },
  { kind: 'messages', args: { confirmations: 0, offset: 0 } },
  { kind: 'messages', args: { confirmations: 0, cursor: [] } },
  { kind: 'messages', args: { confirmations: 0, limit: 501 } },
  { kind: 'messages', args: { confirmations: 0, where: { nope: eq(1) } } },
  { kind: 'messages', args: { confirmations: 0 } },
  { kind: 'messages', args: { confirmations: 1000 } },
  {
    kind: 'messages',
    args: { confirmations: 0 },
    snapshot: { message_ids: null },
  },
  {
    kind: 'messages',
    args: { confirmations: 0 },
    snapshot: { message_ids: 'x' },
  },
  { kind: 'messages', args: { confirmations: 0 }, snapshot: {} },
  { kind: 'messages', args: { confirmations: 0 }, snapshot: null },
  {
    kind: 'messages',
    args: { confirmations: 0 },
    snapshot: { message_ids: [], domains: null, heights: null },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 3,
      columns: ['id', 'msg_id'],
      where: { origin_domain_id: eq(1) },
      order_by: { send_occurred_at: 'desc' },
      limit: 1,
    },
    snapshot: {
      message_ids: ['\\x01', '\\x02'],
      domains: [1, 2],
      heights: ['10', '20'],
    },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      distinct_on: ['sender'],
      order_by: [{ sender: 'asc' }, { id: 'desc' }],
      limit: 1,
    },
  },
  {
    kind: 'messages',
    args: { confirmations: 0, where: { msg_id: eq('\\x01') } },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: { msg_id: { _eq: null, _in: ['\\x01'] } },
    },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: { msg_id: { _eq: '\\x05', _in: ['\\x01'] } },
    },
  },
  {
    kind: 'messages',
    args: { confirmations: 0, where: { msg_id: { _in: 'x' } } },
  },
  { kind: 'messages', args: { confirmations: 0, where: { msg_id: null } } },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: {
        _and: [
          { sender: eq('\\x99') },
          { msg_id: { _in: ['\\x01', '\\x02'] } },
        ],
      },
    },
  },
  {
    kind: 'messages',
    args: { confirmations: 0, where: { _and: { msg_id: eq('\\x03') } } },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: { _or: [{ msg_id: eq('\\x01') }, { msg_id: { _in: ['\\x02'] } }] },
    },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: { _or: [{ msg_id: eq('\\x01') }, { sender: eq('\\x99') }] },
    },
  },
  {
    kind: 'messages',
    args: { confirmations: 0, where: { _or: { msg_id: eq('\\x07') } } },
  },
  {
    kind: 'messages',
    args: { confirmations: 0, where: { _not: { msg_id: eq('\\x01') } } },
  },
  { kind: 'messages', args: { confirmations: 0, where: { _or: [] } } },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: { _or: [{ msg_id: { _in: [] } }, { msg_id: eq('\\x02') }] },
    },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: {
        _and: [{ sender: eq('\\x01') }],
        _or: [{ msg_id: eq('\\x02') }],
        msg_id: eq('\\x03'),
      },
    },
  },
  {
    kind: 'messages',
    args: {
      confirmations: 0,
      where: {
        _and: [
          {
            _or: [
              { msg_id: eq('\\x08') },
              { _and: [{ msg_id: { _in: ['\\x09'] } }] },
            ],
          },
        ],
      },
    },
  },
];

// Shared SQL constants are compared once; per-case SQL references them by name.
const PLACEHOLDERS: [string, string][] = [
  ['{{PROVISIONAL}}', PROVISIONAL_MESSAGE_QUERY],
  ['{{PROJECTED}}', PROJECTED_MESSAGE_QUERY],
  ['{{AFFECTED_FILTERED}}', buildProvisionalMessageAffectedQuery(true)],
  ['{{AFFECTED}}', buildProvisionalMessageAffectedQuery(false)],
];
function compact(sql: string): string {
  for (const [name, text] of PLACEHOLDERS) sql = sql.replaceAll(text, name);
  return sql;
}

const DEFAULT_SNAPSHOT = {
  message_ids: ['\\x0a'],
  domains: [1],
  heights: ['7'],
};

function run(c: Case): unknown {
  switch (c.kind) {
    case 'select':
      return buildSelect(c.table, c.args, c.source);
    case 'count':
      return buildCount(c.table, c.args, c.count);
    case 'byPk':
      return buildByPk(c.table, c.id, c.columns);
    case 'messages':
      throw new Error('async');
  }
}

async function runMessages(c: Extract<Case, { kind: 'messages' }>) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const service = new ScraperDbService({
    async query(sql, values = []) {
      queries.push({ sql: compact(sql), values: structuredClone(values) });
      if (
        queries.length === 1 &&
        'confirmations' in c.args &&
        c.args.confirmations != null
      ) {
        const snapshot =
          c.snapshot === undefined ? DEFAULT_SNAPSHOT : c.snapshot;
        return snapshot === null ? [] : [snapshot];
      }
      return [];
    },
  });
  try {
    await service.selectMessages(c.args);
    return { queries };
  } catch (error) {
    return { error: errorMessage(error), queries };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const results: unknown[] = [];
const out = {
  provisional: {
    provisional: PROVISIONAL_MESSAGE_QUERY,
    projected: PROJECTED_MESSAGE_QUERY,
    affected: buildProvisionalMessageAffectedQuery(false),
    affectedFiltered: buildProvisionalMessageAffectedQuery(true),
  },
  tables: Object.fromEntries(
    Object.entries(tables).map(([name, t]) => [
      name,
      {
        columns: t.columns,
        primaryKey: t.primaryKey ?? null,
        relation: t.relation ?? null,
      },
    ]),
  ),
  cases: results,
};
for (const c of cases) {
  let result: unknown;
  if (c.kind === 'messages') result = await runMessages(c);
  else {
    try {
      result = run(c);
    } catch (error) {
      result = { error: errorMessage(error) };
    }
  }
  out.cases.push({ ...c, result });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
