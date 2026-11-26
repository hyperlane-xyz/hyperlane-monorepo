import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused';

const hook = `0x${'11'.repeat(32)}`;
const query = `query Snapshot($domain: bigint!, $hook: bytea!) {
  merkle_tree_snapshot(domain: $domain, merkle_tree_hook: $hook) {
    domain merkle_tree_hook confirmed_height block_hash root leaf_count leaf_index branch
  }
}`;

void it('rejects invalid snapshot lookups before reading the database', async (t) => {
  const { createScraperProxyApp } = await import('../module.js');
  let calls = 0;
  const app = await createScraperProxyApp({
    async query() {
      calls++;
      return [];
    },
  });
  t.after(() => app.close());
  for (const [domain, address] of [
    [-1, hook],
    ['4294967296', hook],
    [1, '0x12'],
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query, variables: { domain, hook: address } },
    });
    assert(res.json().errors?.length);
  }
  assert.equal(calls, 0);
});

void it(
  'returns the ordered frontier for the exact domain and hook',
  { skip: !process.env.SCRAPER_TEST_DATABASE_URL },
  async (t) => {
    const { createScraperProxyApp } = await import('../module.js');
    pg.types.setTypeParser(17, (value) => value);
    const client = new pg.Client(process.env.SCRAPER_TEST_DATABASE_URL);
    await client.connect();
    t.after(() => client.end());
    const levels = Array.from({ length: 32 }, (_, i) => i);
    await client.query(`CREATE TEMP TABLE merkle_tree_snapshot (
    domain int PRIMARY KEY, merkle_tree_hook bytea, confirmed_height bigint, block_hash bytea,
    root bytea, leaf_count bigint, leaf_index bigint, ${levels.map((i) => `branch_${i} bytea`).join(',')}
  )`);
    const hash = (n: number) =>
      `\\x${n.toString(16).padStart(2, '0').repeat(32)}`;
    const branch = levels.map(hash);
    await client.query(
      `INSERT INTO merkle_tree_snapshot VALUES (-1,$1,123,$2,$3,42,41,${levels.map((i) => `$${i + 4}`).join(',')})`,
      [hash(17), hash(42), hash(43), ...branch],
    );
    const app = await createScraperProxyApp({
      async query(sql, values) {
        return (await client.query(sql, values)).rows;
      },
    });
    t.after(() => app.close());
    const read = async (domain: string, hook: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query, variables: { domain, hook } },
      });
      const body = res.json();
      assert.equal(body.errors, undefined, res.body);
      return body.data.merkle_tree_snapshot;
    };
    assert.deepEqual(await read('4294967295', hook), {
      domain: '4294967295',
      merkle_tree_hook: hash(17),
      confirmed_height: '123',
      block_hash: hash(42),
      root: hash(43),
      leaf_count: '42',
      leaf_index: '41',
      branch,
    });
    assert.equal(await read('1', hook), null);
    assert.equal(await read('4294967295', `0x${'22'.repeat(20)}`), null);
  },
);
