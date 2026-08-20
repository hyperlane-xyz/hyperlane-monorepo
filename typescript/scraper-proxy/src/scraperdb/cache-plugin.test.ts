import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';

import { scraperDbCachePlugin } from './cache-plugin.js';

void it('does not extend cache expiry on hits', async (context) => {
  let now = 0;
  let calls = 0;
  context.mock.method(Date, 'now', () => now);
  const server = new ApolloServer({
    plugins: plugins(),
    resolvers: { Query: { value: () => ++calls } },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { value: Int! }
    `,
  });
  await server.start();
  const query = 'query @cached(ttl: 10) { value }';
  const first = await server.executeOperation({ query });
  assert.equal(value(first), 1);
  assert.equal(first.http.headers.get('cache-control'), 'max-age=10, public');
  now = 5_000;
  assert.equal(value(await server.executeOperation({ query })), 1);
  now = 10_001;
  assert.equal(value(await server.executeOperation({ query })), 2);
  await server.stop();
});

void it('refreshes the same cache entry', async () => {
  let calls = 0;
  const server = new ApolloServer({
    plugins: plugins(),
    resolvers: { Query: { value: () => ++calls } },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { value: Int! }
    `,
  });
  await server.start();
  assert.equal(
    value(
      await server.executeOperation({
        query: 'query @cached(ttl: 10) { value }',
      }),
    ),
    1,
  );
  assert.equal(
    value(
      await server.executeOperation({
        query: 'query @cached(ttl: 20, refresh: true) { value }',
      }),
    ),
    2,
  );
  assert.equal(
    value(
      await server.executeOperation({
        query: 'query @cached(ttl: 10) { value }',
      }),
    ),
    2,
  );
  await server.stop();
});

void it('does not publish cacheable error responses', async () => {
  const server = new ApolloServer({
    plugins: plugins(),
    resolvers: {
      Query: {
        value: () => {
          throw new Error('database unavailable');
        },
      },
    },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { value: Int! }
    `,
  });
  await server.start();
  const response = await server.executeOperation({
    query: 'query @cached(ttl: 10) { value }',
  });
  assert.equal(response.http.headers.get('cache-control'), 'no-store');
  await server.stop();
});

function plugins() {
  return [
    ApolloServerPluginCacheControl({ calculateHttpHeaders: false }),
    scraperDbCachePlugin(),
  ];
}

function value(
  response: Awaited<ReturnType<ApolloServer['executeOperation']>>,
): unknown {
  assert(response.body.kind === 'single');
  return response.body.singleResult.data?.value;
}

void it('evicts the oldest entry at the entry-count limit', async () => {
  let calls = 0;
  const server = cacheServer(() => ++calls, 'Int!');
  await server.start();
  for (let key = 0; key <= 1_000; key++) {
    await cachedValue(server, key);
  }
  await cachedValue(server, 0);
  assert.equal(calls, 1_002);
  await server.stop();
});

void it('evicts the oldest entry at the total-byte limit', async () => {
  let calls = 0;
  const payload = 'x'.repeat(900_000);
  const server = cacheServer(() => {
    calls++;
    return payload;
  });
  await server.start();
  for (let key = 0; key < 19; key++) {
    await cachedValue(server, key);
  }
  await cachedValue(server, 0);
  assert.equal(calls, 20);
  await server.stop();
});

void it('skips oversized and ttl-zero responses', async () => {
  let calls = 0;
  const server = cacheServer(() => {
    calls++;
    return 'x'.repeat(1_000_000);
  });
  await server.start();
  await cachedValue(server, 1);
  await cachedValue(server, 1);
  assert.equal(calls, 2);
  const response = await server.executeOperation({
    query: 'query($key: Int!) @cached(ttl: 0) { value(key: $key) }',
    variables: { key: 2 },
  });
  assert.equal(response.http.headers.get('cache-control'), 'no-store');
  await server.executeOperation({
    query: 'query($key: Int!) @cached(ttl: 0) { value(key: $key) }',
    variables: { key: 2 },
  });
  assert.equal(calls, 4);
  await server.stop();
});

void it('ignores variable-like text inside string literals', async () => {
  let calls = 0;
  const server = new ApolloServer({
    plugins: plugins(),
    resolvers: { Query: { echo: () => ++calls } },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { echo(value: String!): Int! }
    `,
  });
  await server.start();
  const query = 'query @cached(ttl: 10) { echo(value: "$ghost") }';
  await server.executeOperation({ query, variables: { ghost: 1 } });
  await server.executeOperation({ query, variables: { ghost: 2 } });
  assert.equal(calls, 1);
  await server.stop();
});

function cacheServer(
  resolver: () => unknown,
  returnType = 'String!',
): ApolloServer {
  return new ApolloServer({
    plugins: plugins(),
    resolvers: { Query: { value: resolver } },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { value(key: Int!): ${returnType} }
    `,
  });
}

async function cachedValue(server: ApolloServer, key: number): Promise<void> {
  await server.executeOperation({
    query: 'query($key: Int!) @cached(ttl: 10) { value(key: $key) }',
    variables: { key },
  });
}
