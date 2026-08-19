import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { buildSchema } from 'graphql';

import { sanitizeScraperDbSchema } from './schema.js';

void it('only exposes GraphQL queries', () => {
  const source = readFileSync(
    new URL('../graphql/scraperdb-schema.graphql', import.meta.url),
    'utf8',
  );
  const schema = buildSchema(sanitizeScraperDbSchema(source));
  assert(schema.getQueryType());
  assert.equal(schema.getSubscriptionType(), undefined);
});
