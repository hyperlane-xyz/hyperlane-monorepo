import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { buildSchema, parse, validate } from 'graphql';

import { sanitizeScraperDbSchema } from './schema.js';
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
