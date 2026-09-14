import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { ApolloServer } from '@apollo/server';
import Fastify from 'fastify';
import mercurius from 'mercurius';

// Mainnet's busiest observed minute on 2026-09-11: 274 requests,
// 291 DB queries, 132,487 rows, 82ms average DB time.
const OBSERVED_PEAK_RPM = 274;
const OBSERVED_DB_MS = 82;
const OBSERVED_ROWS = 450;
const DURATION_SECONDS = Number(process.env.LOAD_DURATION_SECONDS ?? 5);
const SCALES = [1, 3, 5, 10] as const;
const query = `{
  messages(limit: 450) {
    id msg_id nonce origin destination sender recipient body
    origin_block_height destination_block_height origin_tx_hash destination_tx_hash
    origin_mailbox destination_mailbox is_delivered delivery_latency
  }
}`;
const row = {
  body: `0x${'ab'.repeat(128)}`,
  delivery_latency: '00:00:12',
  destination: 10,
  destination_block_height: '22000000',
  destination_mailbox: `0x${'22'.repeat(32)}`,
  destination_tx_hash: `0x${'44'.repeat(32)}`,
  id: '123456789',
  is_delivered: true,
  msg_id: `0x${'11'.repeat(32)}`,
  nonce: 42,
  origin: 1,
  origin_block_height: '23000000',
  origin_mailbox: `0x${'33'.repeat(32)}`,
  origin_tx_hash: `0x${'55'.repeat(32)}`,
  recipient: `0x${'66'.repeat(32)}`,
  sender: `0x${'77'.repeat(32)}`,
};
const rows = Array.from({ length: OBSERVED_ROWS }, () => row);
const schema = `
  type Message {
    body: String
    delivery_latency: String
    destination: Int
    destination_block_height: String
    destination_mailbox: String
    destination_tx_hash: String
    id: String
    is_delivered: Boolean
    msg_id: String
    nonce: Int
    origin: Int
    origin_block_height: String
    origin_mailbox: String
    origin_tx_hash: String
    recipient: String
    sender: String
  }
  type Query { messages(limit: Int!): [Message!]! }
`;

assert(
  Number.isFinite(DURATION_SECONDS) && DURATION_SECONDS > 0,
  'LOAD_DURATION_SECONDS must be positive',
);

const apollo = new ApolloServer({ resolvers: resolvers(), typeDefs: schema });
await apollo.start();
const interpreted = await mercuriusApp(0);
const jitted = await mercuriusApp(1);
const engines = [
  {
    name: 'apollo',
    run: async () => {
      const response = await apollo.executeOperation({ query });
      assert.equal(response.body.kind, 'single');
      return JSON.stringify(response.body.singleResult);
    },
  },
  {
    name: 'mercurius',
    run: async () => JSON.stringify(await interpreted.graphql(query)),
  },
  {
    name: 'mercurius-jit',
    run: async () => JSON.stringify(await jitted.graphql(query)),
  },
] as const;

const expected = await engines[0].run();
assert.equal(await engines[1].run(), expected);
assert.equal(await engines[2].run(), expected);

console.log(
  `Observed peak model: ${OBSERVED_PEAK_RPM} rpm, ${OBSERVED_DB_MS}ms DB, ${OBSERVED_ROWS} rows/response, ${DURATION_SECONDS}s/scenario`,
);
console.log(
  'engine         load   requests p50ms p95ms p99ms maxInFlight errors',
);
try {
  for (const engine of engines) {
    for (const scale of SCALES) {
      const result = await runLoad(engine.run, scale);
      console.log(
        `${engine.name.padEnd(14)} ${`${scale}x`.padEnd(6)} ${String(result.requests).padEnd(8)} ${String(result.p50).padEnd(5)} ${String(result.p95).padEnd(5)} ${String(result.p99).padEnd(5)} ${String(result.maxInFlight).padEnd(11)} ${result.errors}`,
      );
    }
  }
} finally {
  await Promise.all([apollo.stop(), interpreted.close(), jitted.close()]);
}

function resolvers() {
  return {
    Query: {
      messages: async () => {
        await new Promise((resolve) => setTimeout(resolve, OBSERVED_DB_MS));
        return rows;
      },
    },
  };
}

async function mercuriusApp(jit: number) {
  const app = Fastify({ logger: false });
  await app.register(mercurius, {
    cache: 1_024,
    jit,
    resolvers: resolvers(),
    routes: false,
    schema,
  });
  return app;
}

async function runLoad(run: () => Promise<string>, scale: number) {
  const requests = Math.max(
    1,
    Math.round((OBSERVED_PEAK_RPM / 60) * scale * DURATION_SECONDS),
  );
  const intervalMs = (DURATION_SECONDS * 1_000) / requests;
  const latencies: number[] = [];
  let errors = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const scheduled = Array.from(
    { length: requests },
    (_, index) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          const started = performance.now();
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          void run()
            .catch(() => {
              errors++;
            })
            .finally(() => {
              latencies.push(performance.now() - started);
              inFlight--;
              resolve();
            });
        }, index * intervalMs);
      }),
  );
  await Promise.all(scheduled);
  latencies.sort((left, right) => left - right);
  return {
    errors,
    maxInFlight,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    requests,
  };
}

function percentile(values: number[], quantile: number): number {
  return Math.round(
    values[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0,
  );
}
