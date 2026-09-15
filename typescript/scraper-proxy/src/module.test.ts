import assert from 'node:assert/strict';
import { it } from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';

void it('coalesces concurrent cached HTTP queries and propagates shared errors', async () => {
  const { createScraperProxyApp } = await import('./module.js');
  for (const fail of [false, true]) {
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await createScraperProxyApp({
      async query<T extends Record<string, unknown>>(): Promise<T[]> {
        calls++;
        await blocked;
        if (fail) throw new Error('database unavailable');
        return [];
      },
    });
    try {
      const requests = Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          payload: {
            query: 'query @cached(ttl: 30) { domain(limit: 1) { id } }',
          },
          url: '/graphql',
        }),
      );
      // Let all requests reach the flight before releasing its database query.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(calls, 1);
      release?.();
      const results = await Promise.all(requests);
      assert(
        results.every((result) => result.statusCode === results[0].statusCode),
      );
      assert(results.every((result) => result.body === results[0].body));
      assert.equal(
        results[0].headers['cache-control'],
        fail ? 'no-store' : 'max-age=30, public',
      );
      assert.equal(calls, 1);
    } finally {
      release?.();
      await app.close();
    }
  }
});

void it('serves GraphQL through Mercurius with compatibility validation', async () => {
  let queries = 0;
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp(
    {
      async query<T extends Record<string, unknown>>(): Promise<T[]> {
        queries++;
        return [];
      },
    },
    { jit: 1 },
  );
  try {
    assert.equal(app.server.requestTimeout, 300_000);
    const response = await app.inject({
      headers: { origin: 'https://example.com' },
      method: 'POST',
      payload: {
        query:
          'query Domains($unused: String) { domain(limit: 1) { id name } }',
        variables: { unused: 'legacy-client-variable' },
      },
      url: '/graphql',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { domain: [] } });
    assert.equal(
      response.headers['access-control-allow-origin'],
      'https://example.com',
    );
    assert.equal(queries, 1);

    const getQuery = new URLSearchParams({
      query: 'query Domains($unused: String) { domain(limit: 1) { id name } }',
      variables: JSON.stringify({ unused: 'legacy-client-variable' }),
    });
    const getResponse = await app.inject({
      headers: { 'mercurius-require-preflight': 'true' },
      method: 'GET',
      url: `/graphql?${getQuery}`,
    });
    assert.equal(getResponse.statusCode, 200);
    assert.deepEqual(getResponse.json(), { data: { domain: [] } });
    assert.equal(queries, 2);

    const introspection = await app.inject({
      method: 'POST',
      payload: { query: '{ __schema { queryType { name } } }' },
      url: '/graphql',
    });
    assert.equal(introspection.statusCode, 400);
    assert.match(introspection.body, /Introspection is not allowed/);
  } finally {
    await app.close();
  }
});

void it('preserves cached query and refresh semantics around Mercurius', async () => {
  let queries = 0;
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      queries++;
      return [];
    },
  });
  const request = (refresh = false) =>
    app.inject({
      method: 'POST',
      payload: {
        query: `query @cached(ttl: 30, refresh: ${refresh}) { domain(limit: 1) { id } }`,
      },
      url: '/graphql',
    });
  try {
    const first = await request();
    const cached = await request();
    assert.equal(first.statusCode, 200);
    assert.equal(cached.statusCode, 200);
    assert.deepEqual(cached.json(), first.json());
    assert.equal(first.headers['cache-control'], 'max-age=30, public');
    assert.match(
      cached.headers['cache-control'] ?? '',
      /max-age=(?:30|29), public/,
    );
    assert.equal(queries, 1);

    const refreshed = await request(true);
    assert.equal(refreshed.statusCode, 200);
    assert.equal(queries, 2);
    assert.equal(refreshed.headers['cache-control'], 'max-age=30, public');
  } finally {
    await app.close();
  }
});

void it('rejects malformed variables when the response cache is warm', async () => {
  let queries = 0;
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      queries++;
      return [];
    },
  });
  const query = 'query @cached(ttl: 30) { domain(limit: 1) { id } }';
  const request = (variables: unknown) =>
    app.inject({
      method: 'POST',
      payload: { query, variables },
      url: '/graphql',
    });
  try {
    const first = await request({});
    const cached = await request({});
    assert.equal(first.statusCode, 200);
    assert.equal(cached.statusCode, 200);
    assert.deepEqual(cached.json(), first.json());
    assert.equal(queries, 1);

    for (const malformed of ['{}', 1, true, []]) {
      const response = await request(malformed);
      assert.equal(response.statusCode, 400);
      assert.match(response.body, /variables must be object,null/);
      assert.equal(response.json().data, null);
      assert.equal(queries, 1);
    }

    const malformedGet = await app.inject({
      headers: { 'mercurius-require-preflight': 'true' },
      method: 'GET',
      url: `/graphql?${new URLSearchParams({ query, variables: 'not-json' })}`,
    });
    assert.equal(malformedGet.statusCode, 400);
    assert.equal(queries, 1);

    const duplicateDirective = await request(undefined);
    assert.equal(duplicateDirective.statusCode, 200);
    assert.equal(queries, 1);
    const duplicate = await app.inject({
      method: 'POST',
      payload: {
        query:
          'query @cached(ttl: 30) @cached(ttl: 30) { domain(limit: 1) { id } }',
      },
      url: '/graphql',
    });
    assert.equal(duplicate.statusCode, 400);
    assert.match(
      duplicate.json().errors[0].message,
      /directive "@cached" can only be used once/i,
    );
    assert.equal(queries, 1);
  } finally {
    await app.close();
  }
});

void it('serializes the production query surface consistently', async () => {
  const db = {
    async query(): Promise<Record<string, unknown>[]> {
      return [
        {
          count: 1,
          delivery_latency: null,
          delivery_occurred_at: '2026-09-14T12:00:00.000Z',
          destination_tx_gas_used: '123.45',
          id: 1,
          msg_id: `0x${'11'.repeat(32)}`,
          name: 'ethereum',
          nonce: 42,
        },
      ];
    },
  };
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp(db, { jit: 1 });
  const operations = [
    {
      expected: { domain: [{ id: 1, name: 'ethereum' }] },
      query: '{ domain(limit: 1) { id name } }',
    },
    {
      expected: { domain_by_pk: { id: 1, name: 'ethereum' } },
      query:
        'query Domain($id: Int!, $unused: String) { domain_by_pk(id: $id) { id name } }',
      variables: { id: 1, unused: 'legacy-client-variable' },
    },
    {
      expected: {
        result: {
          aggregate: { count: 1 },
          nodes: [
            {
              delivery_latency: null,
              delivery_occurred_at: '2026-09-14T12:00:00.000Z',
              destination_tx_gas_used: '123.45',
              id: 1,
              msg_id: `0x${'11'.repeat(32)}`,
              nonce: 42,
            },
          ],
        },
      },
      query:
        '{ result: message_view_aggregate(limit: 1) { aggregate { count } nodes { id msg_id nonce delivery_latency delivery_occurred_at destination_tx_gas_used } } }',
    },
    {
      expected: { raw_message_dispatch: [{ id: 1 }] },
      query: '{ raw_message_dispatch(limit: 1) { id } }',
    },
  ];
  try {
    for (const operation of operations) {
      const actual = await app.inject({
        method: 'POST',
        payload: { query: operation.query, variables: operation.variables },
        url: '/graphql',
      });
      assert.equal(actual.statusCode, 200);
      assert.deepEqual(actual.json().data, operation.expected);
    }
  } finally {
    await app.close();
  }
});

void it('bounds concurrent pathological GraphQL requests', async () => {
  const { config } = await import('./config.js');
  let started = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      started++;
      await blocked;
      return [];
    },
  });
  const operation = {
    method: 'POST' as const,
    payload: { query: '{ domain(limit: 1) { id } }' },
    url: '/graphql',
  };
  try {
    const active = Array.from(
      { length: config.GRAPHQL_MAX_ACTIVE_REQUESTS },
      () => app.inject(operation),
    );
    while (started < config.GRAPHQL_MAX_ACTIVE_REQUESTS) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const rejected = await app.inject(operation);
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.headers['retry-after'], '1');

    assert(release);
    release();
    const completed = await Promise.all(active);
    assert(completed.every(({ statusCode }) => statusCode === 200));
    assert.equal((await app.inject(operation)).statusCode, 200);
  } finally {
    release?.();
    await app.close();
  }
});

void it('rejects batch and oversized request bodies', async () => {
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      return [];
    },
  });
  try {
    const batched = await app.inject({
      method: 'POST',
      payload: [{ query: '{ domain { id } }' }, { query: '{ domain { id } }' }],
      url: '/graphql',
    });
    assert.equal(batched.statusCode, 400);

    const oversized = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify({
        query: `#${'x'.repeat(102_400)}\n{ domain { id } }`,
      }),
      url: '/graphql',
    });
    assert.equal(oversized.statusCode, 413);

    const excessiveTokens = await app.inject({
      method: 'POST',
      payload: {
        query: `{ __typename } ${Array.from(
          { length: 1_500 },
          (_, index) => `fragment F${index} on query_root { __typename }`,
        ).join(' ')}`,
      },
      url: '/graphql',
    });
    assert.equal(excessiveTokens.statusCode, 400);
    assert.ok(
      excessiveTokens.body.includes('more than 10000 tokens') ||
        excessiveTokens.body.includes('more that 10000 tokens'),
      excessiveTokens.body,
    );
  } finally {
    await app.close();
  }
});

void it('preserves the CSRF request contract', async () => {
  let queries = 0;
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      queries++;
      return [];
    },
  });
  const url = `/graphql?query=${encodeURIComponent('{ domain { id } }')}`;
  try {
    const unsafe = await app.inject({ method: 'GET', url });
    assert.equal(unsafe.statusCode, 400);
    assert.match(unsafe.body, /Cross-Site Request Forgery/);

    for (const header of [
      'x-apollo-operation-name',
      'apollo-require-preflight',
      'x-mercurius-operation-name',
      'mercurius-require-preflight',
    ]) {
      const safe = await app.inject({
        headers: { [header]: 'Domains' },
        method: 'GET',
        url,
      });
      assert.equal(safe.statusCode, 200);
      assert.deepEqual(safe.json(), { data: { domain: [] } });
    }

    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
    ]) {
      const simplePost = await app.inject({
        headers: { 'content-type': contentType },
        method: 'POST',
        payload: 'query={domain{id}}',
        url: '/graphql',
      });
      assert.equal(simplePost.statusCode, 400);
      assert.match(simplePost.body, /Cross-Site Request Forgery/);
    }

    const graphqlPost = await app.inject({
      headers: { 'content-type': 'application/graphql' },
      method: 'POST',
      payload: '{ domain { id } }',
      url: '/graphql',
    });
    assert.equal(graphqlPost.statusCode, 200);
    assert.deepEqual(graphqlPost.json(), { data: { domain: [] } });

    const preflight = await app.inject({
      headers: {
        'access-control-request-headers': 'mercurius-require-preflight',
        'access-control-request-method': 'GET',
        origin: 'https://example.com',
      },
      method: 'OPTIONS',
      url: '/graphql',
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(
      preflight.headers['access-control-allow-headers'] ?? '',
      /mercurius-require-preflight/i,
    );

    const cachedUrl = `/graphql?query=${encodeURIComponent('query @cached(ttl: 30) { domain { id } }')}`;
    const cachedOperation = {
      headers: { 'mercurius-require-preflight': 'true' },
      method: 'GET' as const,
      url: cachedUrl,
    };
    await app.inject(cachedOperation);
    await app.inject(cachedOperation);
    assert.equal(queries, 6);
  } finally {
    await app.close();
  }
});

void it('returns useful GraphQL parse, validation, and execution errors', async () => {
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      throw new Error('database unavailable');
    },
  });
  const request = (query: string) =>
    app.inject({ method: 'POST', payload: { query }, url: '/graphql' });
  try {
    const parsed = await request('{');
    assert.equal(parsed.statusCode, 400);
    assert.match(parsed.json().errors[0].message, /Syntax Error/);

    const validated = await request('{ missing_field }');
    assert.equal(validated.statusCode, 400);
    assert.match(validated.json().errors[0].message, /Cannot query field/);

    const executed = await request('{ domain(limit: 1) { id } }');
    assert.equal(executed.statusCode, 200);
    assert.equal(executed.json().errors[0].message, 'database unavailable');
  } finally {
    await app.close();
  }
});

void it('does not cache pathological resolver failures', async () => {
  let queries = 0;
  const { createScraperProxyApp } = await import('./module.js');
  const app = await createScraperProxyApp({
    async query<T extends Record<string, unknown>>(): Promise<T[]> {
      queries++;
      if (queries === 1) throw new Error('database unavailable');
      return [];
    },
  });
  const operation = {
    method: 'POST' as const,
    payload: {
      query: 'query @cached(ttl: 30) { domain(limit: 1) { id } }',
    },
    url: '/graphql',
  };
  try {
    const failed = await app.inject(operation);
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.match(failed.body, /database unavailable/);
    const succeeded = await app.inject(operation);
    assert.deepEqual(succeeded.json(), { data: { domain: [] } });
    assert.equal(queries, 2);
  } finally {
    await app.close();
  }
});
