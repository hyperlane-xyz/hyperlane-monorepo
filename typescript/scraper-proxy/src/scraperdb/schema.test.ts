import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { buildSchema, parse, validate } from 'graphql';

import { sanitizeScraperDbSchema } from './schema.js';

void it('only exposes GraphQL queries', () => {
  const source = readFileSync(
    new URL('../graphql/scraperdb-schema.graphql', import.meta.url),
    'utf8',
  );
  const schema = buildSchema(sanitizeScraperDbSchema(source));
  assert(schema.getQueryType());
  assert.equal(schema.getSubscriptionType(), undefined);
  assert.equal(
    schema.getType('String_comparison_exp')?.toString(),
    'String_comparison_exp',
  );
  assert(!sanitizeScraperDbSchema(source).includes('_regex'));
});

void it('bounds repeated fragment DAG validation work', async () => {
  const source = readFileSync(
    new URL('../graphql/scraperdb-schema.graphql', import.meta.url),
    'utf8',
  );
  const schema = buildSchema(sanitizeScraperDbSchema(source));
  const fragments = Array.from({ length: 24 }, (_, index) =>
    index === 0
      ? 'fragment F0 on domain { id }'
      : `fragment F${index} on domain { ...F${index - 1} ...F${index - 1} }`,
  ).join('\n');
  const query = `query { domain { ...F23 } }\n${fragments}`;
  const started = performance.now();
  const { scraperProxyValidationRule } = await import('./validation.js');
  const errors = validate(schema, parse(query), [scraperProxyValidationRule]);
  assert(performance.now() - started < 250);
  assert(errors.some(({ message }) => message.includes('exceeds maximum')));
});
