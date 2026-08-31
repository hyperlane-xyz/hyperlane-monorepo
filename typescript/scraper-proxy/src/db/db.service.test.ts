import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { it } from 'node:test';

import pg from 'pg';

process.env.DATABASE_URL ??= 'postgresql://scraper-proxy-test';
process.env.DATABASE_READ_REPLICA_URL ??=
  'postgresql://scraper-proxy-replica-test';
process.env.DATABASE_QUERY_TIMEOUT_MS ??= '1000';

void it('keeps replica health from gating primary live queries', async (context) => {
  const saturatedPools = new WeakSet<pg.Pool>();
  const queryUrls = new Map<string, string>();
  let connectAttempts = 0;
  let releaseMain: (() => void) | undefined;
  context.mock.method(pg.Pool.prototype, 'connect', () => {
    connectAttempts++;
    throw new Error('replica unavailable');
  });
  context.mock.method(
    pg.Pool.prototype,
    'query',
    function (this: pg.Pool, text: string) {
      queryUrls.set(text, this.options.connectionString);
      if (text === 'SELECT pg_sleep(1)') {
        saturatedPools.add(this);
        return new Promise((resolve) => {
          releaseMain = () => resolve({ rowCount: 0, rows: [] });
        });
      }
      if (text === 'SELECT fail')
        return Promise.reject(new Error('query failed'));
      assert(!saturatedPools.has(this));
      return Promise.resolve({ rowCount: 0, rows: [{ ready: 1 }] });
    },
  );
  const { DbService } = await import('./db.service.js');
  const db = new DbService();
  context.after(() => db.onModuleDestroy());

  await db.onModuleInit();
  assert.equal(connectAttempts, 0);
  const saturated = db.query('SELECT pg_sleep(1)');
  assert.deepEqual(await db.queryLive('SELECT 1'), [{ ready: 1 }]);
  assert.equal(
    queryUrls.get('SELECT pg_sleep(1)'),
    process.env.DATABASE_READ_REPLICA_URL,
  );
  assert.equal(queryUrls.get('SELECT 1'), process.env.DATABASE_URL);
  assert(releaseMain);
  releaseMain();
  await saturated;
  await assert.rejects(db.query('SELECT fail'), /query failed/);
  const { metricsRegistry } = await import('../metrics.js');
  const metrics = await metricsRegistry.metrics();
  assert.match(
    metrics,
    /database_queries_total\{(?=[^}]*role="graphql_replica")(?=[^}]*outcome="success")[^}]*\} 1/,
  );
  assert.match(
    metrics,
    /database_queries_total\{(?=[^}]*role="graphql_replica")(?=[^}]*outcome="error")[^}]*\} 1/,
  );
  assert.match(
    metrics,
    /database_queries_total\{(?=[^}]*role="live_primary")(?=[^}]*outcome="success")[^}]*\} 1/,
  );
});

void it('times out stalled replica connections', async (context) => {
  context.mock.method(Socket.prototype, 'connect', function () {
    return this;
  });
  const { DbService } = await import('./db.service.js');
  const db = new DbService();
  context.after(() => db.onModuleDestroy());

  const started = Date.now();
  await assert.rejects(db.query('SELECT 1'), /connection timeout/i);
  const duration = Date.now() - started;
  assert(duration >= 1_000);
  assert(duration < 3_000);
});
