import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ApolloServer } from '@apollo/server';

import { scraperDbCachePlugin } from './cache-plugin.js';

void it('does not extend cache expiry on hits', async (context) => {
  let now = 0;
  let calls = 0;
  context.mock.method(Date, 'now', () => now);
  const server = new ApolloServer({
    plugins: [scraperDbCachePlugin()],
    resolvers: { Query: { value: () => ++calls } },
    typeDefs: `
      directive @cached(ttl: Int, refresh: Boolean) on QUERY
      type Query { value: Int! }
    `,
  });
  await server.start();
  const query = 'query @cached(ttl: 10) { value }';
  assert.equal(value(await server.executeOperation({ query })), 1);
  now = 5_000;
  assert.equal(value(await server.executeOperation({ query })), 1);
  now = 10_001;
  assert.equal(value(await server.executeOperation({ query })), 2);
  await server.stop();
});

function value(
  response: Awaited<ReturnType<ApolloServer['executeOperation']>>,
): unknown {
  assert.equal(response.body.kind, 'single');
  return response.body.singleResult.data?.value;
}
