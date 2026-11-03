import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildSchema } from 'graphql';
import { schema as source } from './schema.js';

import { GraphqlResponseCache } from './response-cache.js';

void it('canonicalizes generated nested variable-key permutations', () => {
  const cache = new GraphqlResponseCache();
  const query = `
    query Cached($filter: domain_bool_exp!) @cached(ttl: 30) {
      domain(where: $filter) { id }
    }
  `;
  const schema = buildSchema(source);
  for (let index = 0; index < 200; index++) {
    const entries: Array<[string, unknown]> = [
      ['id', { _eq: index }],
      ['is_deprecated', { _eq: index % 2 === 0 }],
      ['name', { _eq: `domain-${index}` }],
    ];
    const forward = { filter: Object.fromEntries(entries) };
    const reverse = { filter: Object.fromEntries(entries.toReversed()) };
    const write = cache.prepare(schema, { query, variables: forward });
    const read = cache.prepare(schema, { query, variables: reverse });
    assert(write && read);
    cache.write(write, `result-${index}`);
    assert.equal(cache.read(read)?.body, `result-${index}`);
  }
});

void it('memoizes query validation without reusing request variables or crossing schemas', (t) => {
  const cache = new GraphqlResponseCache();
  const schema = buildSchema(source);
  const validation = t.mock.method(schema, 'getQueryType');
  const query = `
    query First($id: Int!, $ttl: Int!, $refresh: Boolean!) @cached(ttl: $ttl, refresh: $refresh) {
      domain(where: {id: {_eq: $id}}) { id }
    }
  `;
  const body = {
    query,
    operationName: 'First',
    variables: { id: 1, ttl: 30, refresh: false },
  };
  const first = cache.prepare(schema, body);
  assert(first);
  cache.write(first, 'first');
  const calls = validation.mock.callCount();
  assert(calls > 0);
  assert.deepEqual(cache.prepare(schema, body), first);
  assert.equal(validation.mock.callCount(), calls);
  const changed = cache.prepare(schema, {
    ...body,
    variables: { id: 2, ttl: 10, refresh: true },
  });
  assert(changed);
  assert.notEqual(changed.key, first.key);
  assert.equal(changed.ttl, 10);
  assert.equal(changed.refresh, true);
  assert.equal(cache.read(changed), null);
  assert.equal(
    cache.prepare(schema, {
      ...body,
      variables: { id: 'invalid', ttl: 30, refresh: false },
    }),
    null,
  );
  assert.equal(
    cache.prepare(schema, { ...body, variables: { ttl: 30, refresh: false } }),
    null,
  );
  const unnamed = cache.prepare(schema, { ...body, operationName: undefined });
  assert(unnamed);
  assert.notEqual(unnamed.key, first.key);
  assert.equal(
    cache.prepare(schema, { ...body, operationName: 'Missing' }),
    null,
  );
  assert.equal(
    cache.prepare(buildSchema('type Query { other: Int }'), body),
    null,
  );
  assert.equal(cache.read(first)?.body, 'first');
});

void it('bounds prepared documents with LRU eviction and skips oversized query text', (t) => {
  const cache = new GraphqlResponseCache();
  const schema = buildSchema(source);
  const validation = t.mock.method(schema, 'getQueryType');
  const query = 'query @cached { domain { id } }';
  const prepare = (suffix: string) => {
    assert(cache.prepare(schema, { query: `${query} #${suffix}` }));
  };
  for (let i = 0; i < 256; i++) prepare(String(i));
  const calls = validation.mock.callCount();
  prepare('0');
  assert.equal(validation.mock.callCount(), calls);
  prepare('256');
  const afterInsert = validation.mock.callCount();
  prepare('0');
  assert.equal(validation.mock.callCount(), afterInsert);
  prepare('1');
  assert(
    validation.mock.callCount() > afterInsert,
    'least recently used document was evicted',
  );
  for (let i = 0; i < 2; i++) {
    const before = validation.mock.callCount();
    prepare('x'.repeat(8192));
    assert(
      validation.mock.callCount() > before,
      'large query was not retained',
    );
  }
});
