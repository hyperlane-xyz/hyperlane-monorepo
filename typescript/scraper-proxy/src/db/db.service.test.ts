import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

process.env.DATABASE_URL ??= 'postgresql://scraper-proxy-test';

void it('keeps live queries prompt while the main pool is saturated', async (context) => {
  const saturatedPools = new WeakSet<pg.Pool>();
  let releaseMain: (() => void) | undefined;
  context.mock.method(
    pg.Pool.prototype,
    'query',
    function (this: pg.Pool, text: string) {
      if (text === 'SELECT pg_sleep(1)') {
        saturatedPools.add(this);
        return new Promise((resolve) => {
          releaseMain = () => resolve({ rowCount: 0, rows: [] });
        });
      }
      assert(!saturatedPools.has(this));
      return Promise.resolve({ rowCount: 0, rows: [{ ready: 1 }] });
    },
  );
  const { DbService } = await import('./db.service.js');
  const db = new DbService();

  const saturated = db.query('SELECT pg_sleep(1)');
  assert.deepEqual(await db.queryLive('SELECT 1'), [{ ready: 1 }]);
  assert(releaseMain);
  releaseMain();
  await saturated;
  await db.onModuleDestroy();
});
