import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ApolloServer, type ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';

import { scraperDbCachePlugin } from '../scraperdb/cache-plugin.js';
import { normalizeGraphqlRequestBody } from '../scraperdb/request-compatibility.js';
import { scraperProxyValidationRule } from '../scraperdb/validation.js';

const variants: Array<{ name: string; plugin: () => ApolloServerPlugin }> = [];
if (process.argv[2]) {
  const baseline: typeof import('../scraperdb/cache-plugin.js') = await import(
    pathToFileURL(resolve(process.argv[2])).href
  );
  variants.push({ name: 'baseline', plugin: baseline.scraperDbCachePlugin });
}
variants.push({ name: 'current', plugin: scraperDbCachePlugin });

// Synthetic queries at two sizes within the production field/root/alias limits.
// Includes request normalization and Apollo execution, excluding HTTP and DB IO.
for (const fields of [50, 250]) {
  const names = Array.from({ length: fields - 1 }, (_, i) => `f${i}`);
  const payload = Object.fromEntries(names.map((name) => [name, 1]));
  const expectedData = JSON.stringify({ value: payload });
  const query = `query($key: Int!) @cached(ttl: 300) { value(key: $key) { ${names.join(' ')} } }`;
  for (let run = 0; run < 3; run++) {
    for (const { name, plugin } of variants) {
      let calls = 0;
      const server = new ApolloServer({
        plugins: [
          ApolloServerPluginCacheControl({ calculateHttpHeaders: false }),
          plugin(),
        ],
        validationRules: [scraperProxyValidationRule],
        typeDefs: `directive @cached(ttl: Int, refresh: Boolean) on QUERY
          type Query { value(key: Int!): Value! }
          type Value { ${names.map((field) => `${field}: Int!`).join(' ')} }`,
        resolvers: {
          Query: {
            value: () => {
              calls++;
              return payload;
            },
          },
        },
      });
      await server.start();
      try {
        const execute = async () => {
          const request = { query, variables: { key: 1 } };
          normalizeGraphqlRequestBody(request);
          const response = await server.executeOperation(request);
          assert(response.body.kind === 'single');
          assert.equal(response.body.singleResult.errors, undefined);
          assert.equal(
            JSON.stringify(response.body.singleResult.data),
            expectedData,
          );
        };
        for (let i = 0; i < 100; i++) await execute();
        const start = performance.now();
        for (let i = 0; i < 1_000; i++) await execute();
        console.log(
          JSON.stringify({
            name,
            fields,
            run,
            requests: 1_000,
            elapsedMs: performance.now() - start,
          }),
        );
        assert.equal(calls, 1);
      } finally {
        await server.stop();
      }
    }
  }
}
