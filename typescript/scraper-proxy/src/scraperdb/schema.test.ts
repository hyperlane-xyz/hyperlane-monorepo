import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { buildSchema, graphql, parse, validate } from 'graphql';

import { sanitizeScraperDbSchema } from './schema.js';
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
