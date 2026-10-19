import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { buildSchema, graphql, parse, validate } from 'graphql';

import { sanitizeScraperDbSchema } from './schema.js';
import {
  type MessageSelectArgs,
  ScraperDbService,
} from './scraperdb.service.js';
import { buildSelect, type SelectArgs } from './sql.js';
import { scraperProxyValidationRule } from './validation.js';

const source = readFileSync(
  new URL('../graphql/scraperdb-schema.graphql', import.meta.url),
  'utf8',
);
const sanitized = sanitizeScraperDbSchema(source);
const schema = buildSchema(sanitized);

void it('only exposes GraphQL queries', () => {
  assert(schema.getQueryType());
  assert.equal(schema.getSubscriptionType(), undefined);
  assert.equal(
    schema.getType('String_comparison_exp')?.toString(),
    'String_comparison_exp',
  );
});

void it('removes unsupported regex operators from the schema', () => {
  assert(!sanitized.includes('_regex'));
});

void it('bounds repeated fragment DAG validation work', () => {
  const fragments = Array.from({ length: 24 }, (_, index) =>
    index === 0
      ? 'fragment F0 on domain { id }'
      : `fragment F${index} on domain { ...F${index - 1} ...F${index - 1} }`,
  ).join('\n');
  const query = `query { domain { ...F23 } }\n${fragments}`;
  const errors = validate(schema, parse(query), [scraperProxyValidationRule]);
  assert(errors.some(({ message }) => message.includes('exceeds maximum')));
});

void it('reports introspection rejection directly', () => {
  const errors = validate(
    schema,
    parse('{ __schema { queryType { name } } }'),
    [scraperProxyValidationRule],
  );
  assert(
    errors.some(({ message }) => message === 'Introspection is not allowed'),
  );
});

void it('accepts literal and variable null optional arguments', async () => {
  const rootValue = {
    domain: (args: SelectArgs) => {
      buildSelect('domain', args);
      return [];
    },
  };
  const literal = await graphql({
    rootValue,
    schema,
    source:
      '{ domain(limit: null, offset: null, order_by: { id: null }) { id } }',
  });
  const variable = await graphql({
    rootValue,
    schema,
    source:
      'query Nullable($limit: Int, $offset: Int, $order: domain_order_by!) { domain(limit: $limit, offset: $offset, order_by: [$order]) { id } }',
    variableValues: { limit: null, offset: null, order: { id: null } },
  });

  assert.equal(literal.errors, undefined);
  assert.equal(variable.errors, undefined);
});

void it('accepts a cursor on message queries', () => {
  const errors = validate(
    schema,
    parse(`
      query Messages($cursor: bigint!) {
        message_view(
          cursor: [{initial_value: {id: $cursor}, ordering: DESC}]
          order_by: {id: desc}
          limit: 50
        ) { id }
      }
    `),
  );

  assert.deepEqual(errors, []);
});

void it('accepts optional message confirmations', () => {
  const errors = validate(
    schema,
    parse(`
      query Messages($confirmations: Int) {
        message_view(confirmations: $confirmations, where: {is_provisional: {_eq: true}}, limit: 50) { id is_provisional origin_block_height }
      }
    `),
  );

  assert.deepEqual(errors, []);
});

void it('rejects invalid confirmations before querying the database', async () => {
  const db = new ScraperDbService({
    async query() {
      assert.fail('Unexpected database query');
    },
  });
  await assert.rejects(
    db.selectMessages({ confirmations: -1 }),
    /non-negative/,
  );
  for (const confirmations of [1_001, 100_000, 2_147_483_647]) {
    await assert.rejects(
      db.selectMessages({ confirmations }),
      /maximum of 1000/,
    );
  }
  await assert.rejects(
    db.selectMessages({
      confirmations: 0,
      cursor: [{ initial_value: { id: 2 }, ordering: 'DESC' }],
    }),
    /paginate canonical history separately/,
  );
  await assert.rejects(
    db.selectMessages({ confirmations: 0, offset: 1 }),
    /offset/,
  );
});

void it('rejects an empty message cursor through the resolver', async () => {
  const response = await graphql({
    rootValue: {
      message_view: (args: SelectArgs) => {
        buildSelect('message_view', args);
        return [];
      },
    },
    schema,
    source: '{ message_view(cursor: [{initial_value: {}}]) { id } }',
  });

  assert.match(response.errors?.[0]?.message ?? '', /must contain one column/);
});

void it('bounds affected scans using necessary message ID predicates', async () => {
  const cases: { where: SelectArgs['where']; expected?: string[] }[] = [
    { where: { msg_id: { _eq: '\\x01' } }, expected: ['\\x01'] },
    {
      where: {
        _and: [
          { sender: { _eq: '\\x99' } },
          { msg_id: { _in: ['\\x01', '\\x02'] } },
        ],
      },
      expected: ['\\x01', '\\x02'],
    },
    {
      where: {
        _or: [{ msg_id: { _eq: '\\x01' } }, { msg_id: { _in: ['\\x02'] } }],
      },
      expected: ['\\x01', '\\x02'],
    },
    {
      where: {
        _or: [{ msg_id: { _eq: '\\x01' } }, { sender: { _eq: '\\x99' } }],
      },
    },
    { where: { _not: { msg_id: { _eq: '\\x01' } } } },
    { where: { _or: [] }, expected: [] },
  ];
  for (const { where, expected } of cases) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const service = new ScraperDbService({
      async query(sql, values = []) {
        queries.push({ sql, values });
        return queries.length === 1
          ? [{ message_ids: [], domains: [], heights: [] }]
          : [];
      },
    });
    await service.selectMessages({ confirmations: 1000, where });
    assert.deepEqual(
      queries[0].values,
      expected === undefined ? [1000] : [1000, expected],
    );
    assert.match(queries[0].sql, /UNION ALL/);
    assert.match(queries[0].sql, /LIMIT 10001/);
    assert.equal(
      queries[0].sql.includes('LATERAL (\n    SELECT delivery'),
      false,
    );
  }
});

void it('rejects excessive affected events before running a projection', async () => {
  let calls = 0;
  const service = new ScraperDbService({
    async query() {
      calls++;
      return [{ message_ids: null }];
    },
  });
  await assert.rejects(
    service.selectMessages({ confirmations: 0 }),
    /10000 affected events/,
  );
  assert.equal(calls, 1);
});

void it('keeps canonical aliases when a provisional snapshot exceeds the cap', async () => {
  const service = new ScraperDbService({
    async query(sql) {
      return sql.includes('custom_frontier')
        ? [{ message_ids: null }]
        : [{ id: '1' }];
    },
  });
  const result = await graphql({
    schema,
    rootValue: {
      message_view: (args: MessageSelectArgs) => service.selectMessages(args),
    },
    source:
      '{ canonical: message_view(limit: 3) { id } provisional: message_view(confirmations: 0) { id } }',
  });
  assert(result.data);
  assert.equal(result.data.provisional, null);
  assert.deepEqual(
    result.data.canonical?.map((row: { id: string }) => row.id),
    ['1'],
  );
  assert.deepEqual(
    result.errors?.map((error) => error.path),
    [['provisional']],
  );
  assert.match(result.errors?.[0]?.message ?? '', /10000 affected events/);
});
