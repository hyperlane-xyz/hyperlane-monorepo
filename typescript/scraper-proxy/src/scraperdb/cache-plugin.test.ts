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
  assert.equal(response.body.kind, 'single');
  return response.body.singleResult.data?.value;
}
