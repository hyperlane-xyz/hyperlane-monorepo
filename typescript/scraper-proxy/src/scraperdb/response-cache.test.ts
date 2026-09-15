import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getOperationAST, parse } from 'graphql';

import {
  GraphqlResponseCache,
  type SharedGraphqlResponse,
} from './response-cache.js';

const response: SharedGraphqlResponse = {
  body: '{"data":{"domain":[]}}',
  cacheControl: 'max-age=30, public',
  statusCode: 200,
};

function prepare(
  cache: GraphqlResponseCache,
  refresh = false,
  id = 1,
  ttl = 30,
) {
  const document = parse(
    `query @cached(ttl: ${ttl}, refresh: ${refresh}) { domain(limit: ${id}) { id } }`,
  );
  const operation = getOperationAST(document);
  assert(operation);
  const request = cache.prepare(document, operation, null, {});
  assert(request);
  return request;
}

void it('coalesces fills and shares failures without caching them', async () => {
  const cache = new GraphqlResponseCache();
  const leader = prepare(cache);
  assert.equal(await cache.acquire(leader), null);
  const followers = Array.from({ length: 20 }, () =>
    cache.acquire(prepare(cache)),
  );
  const failure = {
    ...response,
    body: '{"errors":[{"message":"unavailable"}]}',
    cacheControl: 'no-store',
    statusCode: 503,
  };
  cache.complete(leader, failure, false);
  assert.deepEqual(await Promise.all(followers), Array(20).fill(failure));
  const retry = prepare(cache);
  assert.equal(await cache.acquire(retry), null);
  cache.complete(retry, response, true);
  assert.deepEqual(await cache.acquire(prepare(cache)), response);
});

void it('replaces a fill at capacity and coalesces refreshes without stale overwrite', async () => {
  const cache = new GraphqlResponseCache(1);
  const old = prepare(cache);
  await cache.acquire(old);
  const oldWaiter = cache.acquire(prepare(cache));
  const refresh = prepare(cache, true);
  assert.equal(await cache.acquire(refresh), null);
  const refreshWaiter = cache.acquire(prepare(cache, true));
  cache.complete(refresh, response, true);
  assert.deepEqual(await refreshWaiter, response);
  const stale = { ...response, body: 'stale' };
  cache.complete(old, stale, true);
  assert.deepEqual(await oldWaiter, stale);
  assert.deepEqual(await cache.acquire(prepare(cache)), response);
});

void it('bypasses new keys at capacity and releases abandoned owners', async () => {
  const cache = new GraphqlResponseCache(1);
  const leader = prepare(cache);
  await cache.acquire(leader);
  const bypass = prepare(cache, false, 2);
  assert.equal(await cache.acquire(bypass), null);
  cache.complete(bypass, response, true);
  assert.equal(cache.read(prepare(cache, false, 2)), null);
  const waiter = cache.acquire(prepare(cache));
  cache.abandon(leader);
  assert.equal(await waiter, null);
  cache.complete(leader, response, true);
  assert.equal(cache.read(prepare(cache)), null);
  const next = prepare(cache, false, 2);
  assert.equal(await cache.acquire(next), null);
  cache.complete(next, response, true);
  assert.deepEqual(await cache.acquire(prepare(cache, false, 2)), response);
});

void it('shares oversized and ttl-zero results without retaining them', async () => {
  for (const [ttl, body] of [
    [0, response.body],
    [30, 'x'.repeat(1_000_001)],
  ] as const) {
    const cache = new GraphqlResponseCache();
    const leader = prepare(cache, false, 1, ttl);
    await cache.acquire(leader);
    const waiter = cache.acquire(prepare(cache, false, 1, ttl));
    const result = { ...response, body };
    cache.complete(leader, result, true);
    assert.deepEqual(await waiter, result);
    assert.equal(cache.read(prepare(cache, false, 1, ttl)), null);
  }
});

void it('canonicalizes generated nested variable-key permutations', () => {
  const cache = new GraphqlResponseCache();
  const query = `
    query Cached($filter: domain_bool_exp!) @cached(ttl: 30) {
      domain(where: $filter) { id }
    }
  `;
  const document = parse(query);
  const operation = getOperationAST(document);
  assert(operation);
  for (let index = 0; index < 200; index++) {
    const entries: Array<[string, unknown]> = [
      ['id', { _eq: index }],
      ['is_deprecated', { _eq: index % 2 === 0 }],
      ['name', { _eq: `domain-${index}` }],
    ];
    const forward = { filter: Object.fromEntries(entries) };
    const reverse = { filter: Object.fromEntries(entries.toReversed()) };
    const write = cache.prepare(document, operation, null, forward);
    const read = cache.prepare(document, operation, null, reverse);
    assert(write && read);
    cache.write(write, `result-${index}`);
    assert.equal(cache.read(read)?.body, `result-${index}`);
  }
});
