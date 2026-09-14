import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { ApolloServer } from '@apollo/server';
import Fastify from 'fastify';
import mercurius from 'mercurius';

const ITERATIONS = 5_000;
const WARMUP = 250;
const query = `{
  domain(limit: 1) {
    chain_id id is_deprecated is_test_net name native_token time_created time_updated
  }
}`;
const row = {
  chain_id: '1',
  id: 1,
  is_deprecated: false,
  is_test_net: false,
  name: 'ethereum',
  native_token: 'ETH',
  time_created: '2026-01-01T00:00:00Z',
  time_updated: '2026-01-01T00:00:00Z',
};
const resolvers = {
  Query: { domain: () => [row] },
};
// Isolates parse/validate/execute cost from HTTP and database IO.
const schema = `
  scalar bigint
  scalar timestamp
  type Domain {
    chain_id: bigint
    id: Int!
    is_deprecated: Boolean!
    is_test_net: Boolean!
    name: String!
    native_token: String!
    time_created: timestamp!
    time_updated: timestamp!
  }
  type Query { domain(limit: Int): [Domain!]! }
`;

const apollo = new ApolloServer({
  resolvers,
  typeDefs: schema,
});
await apollo.start();
const interpreted = await mercuriusApp(0);
const jitted = await mercuriusApp(1);

try {
  const apolloRun = async () => apollo.executeOperation({ query });
  const interpretedRun = async () => interpreted.graphql(query);
  const jittedRun = async () => jitted.graphql(query);
  const expected = JSON.stringify(await apolloRun());
  assert.equal(JSON.stringify(await interpretedRun()), graphqlBody(expected));
  assert.equal(JSON.stringify(await jittedRun()), graphqlBody(expected));

  for (const [name, run] of [
    ['apollo', apolloRun],
    ['mercurius', interpretedRun],
    ['mercurius-jit', jittedRun],
  ] as const) {
    for (let index = 0; index < WARMUP; index++) await run();
    const started = performance.now();
    for (let index = 0; index < ITERATIONS; index++) await run();
    const elapsed = performance.now() - started;
    console.log(
      `${name.padEnd(14)} ${Math.round((ITERATIONS * 1_000) / elapsed).toLocaleString()} ops/s (${elapsed.toFixed(1)}ms)`,
    );
  }
} finally {
  await Promise.all([apollo.stop(), interpreted.close(), jitted.close()]);
}

async function mercuriusApp(jit: number) {
  const app = Fastify({ logger: false });
  await app.register(mercurius, {
    cache: 1_024,
    jit,
    resolvers,
    routes: false,
    schema,
  });
  return app;
}

function graphqlBody(apolloResponse: string): string {
  const response: unknown = JSON.parse(apolloResponse);
  assert(response && typeof response === 'object' && 'body' in response);
  const body = response.body;
  assert(body && typeof body === 'object' && 'singleResult' in body);
  return JSON.stringify(body.singleResult);
}
