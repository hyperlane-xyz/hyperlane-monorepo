import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused';

const hook = `0x${'11'.repeat(20)}`;
const pageQuery = `query Page($domain: bigint!, $hook: bytea!, $from: bigint, $limit: Int) {
  merkle_tree_insertions(domain: $domain, merkle_tree_hook: $hook, from_index: $from, limit: $limit) {
    insertions { domain merkle_tree_hook leaf_index message_id block_number }
    next_index
  }
}`;

void it('rejects invalid insertion scopes, cursors and page sizes before database reads', async () => {
  const { createScraperProxyApp } = await import('../module.js');
  const app = await createScraperProxyApp({
    async query() {
      assert.fail('Invalid input must not query the database');
    },
  });
  try {
    for (const invalid of [
      { limit: 0 },
      { limit: -1 },
      { limit: 1001 },
      { from: -1 },
      { from: '4294967296' },
      { from: true },
      { from: 0.5 },
      { domain: -1 },
      { domain: '4294967296' },
      { hook: '0x12' },
      { hook: {} },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: pageQuery,
          variables: { domain: 1, hook, ...invalid },
        },
      });
      assert(response.json().errors?.length, JSON.stringify(invalid));
    }
    const single = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: {
        query: `{ merkle_tree_insertion(domain: 1, merkle_tree_hook: "${hook}", leaf_index: -1) { leaf_index } }`,
      },
    });
    assert(single.json().errors?.length);
  } finally {
    await app.close();
  }
});

void it(
  'pages confirmed insertions and resolves a single leaf through PostgreSQL and GraphQL',
  {
    skip: !process.env.SCRAPER_TEST_DATABASE_URL,
  },
  async () => {
    const { createScraperProxyApp } = await import('../module.js');
    pg.types.setTypeParser(17, (value) => value);
    const client = new pg.Client(process.env.SCRAPER_TEST_DATABASE_URL);
    await client.connect();
    const plans: string[] = [];
    const app = await createScraperProxyApp({
      async query(sql, values) {
        const { rows } = await client.query(sql, values);
        if (sql.startsWith('EXPLAIN')) plans.push(JSON.stringify(rows));
        return rows;
      },
    });
    const request = async (
      query: string,
      variables: Record<string, unknown>,
    ) => {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query, variables },
      });
      const body = response.json();
      assert.equal(body.errors, undefined, response.body);
      return body.data;
    };
    try {
      await client.query(`
      CREATE TEMP TABLE merkle_tree_insertion (
        domain integer, merkle_tree_hook bytea, leaf_index integer,
        message_id bytea, block_number bigint,
        UNIQUE (domain, merkle_tree_hook, leaf_index)
      );
      CREATE TEMP TABLE scraper_head (domain integer PRIMARY KEY, confirmed_height bigint);
      INSERT INTO scraper_head VALUES (1, 1001), (2, 1001), (-1, 1001);
      CREATE TEMP VIEW confirmed_merkle_tree_insertion AS
        SELECT e.* FROM merkle_tree_insertion e
        WHERE e.block_number <= (SELECT h.confirmed_height FROM scraper_head h WHERE h.domain=e.domain);
      INSERT INTO merkle_tree_insertion
        SELECT 1, decode(repeat('11',20),'hex'), i, decode(lpad(to_hex(i),64,'0'),'hex'), i+1
        FROM generate_series(0,1001) i;
      INSERT INTO merkle_tree_insertion VALUES
        (1, decode(repeat('22',20),'hex'), 0, decode(repeat('22',32),'hex'), 1),
        (2, decode(repeat('11',20),'hex'), 0, decode(repeat('33',32),'hex'), 1);
      INSERT INTO merkle_tree_insertion
        SELECT -1, decode(repeat('11',20),'hex'), i, decode(repeat('44',32),'hex'), 1
        FROM unnest(ARRAY[2147483647, -2147483648, -1]) i;
      -- Verify that pagination can use index order, even on this small fixture.
      SET enable_seqscan=off;
      SET enable_bitmapscan=off;
    `);
      const first = (await request(pageQuery, { domain: 1, hook }))
        .merkle_tree_insertions;
      assert.equal(first.insertions.length, 1000);
      assert.equal(first.insertions[0].leaf_index, '0');
      assert.equal(first.insertions[999].leaf_index, '999');
      assert.equal(first.next_index, '1000');
      const firstPlan = plans[0];
      assert(firstPlan);
      assert.match(firstPlan, /"Node Type":"Index(?: Only)? Scan"/);
      assert.doesNotMatch(firstPlan, /"Node Type":"(?:Incremental )?Sort"/);
      assert.deepEqual(first.insertions[0], {
        domain: '1',
        merkle_tree_hook: `\\x${'11'.repeat(20)}`,
        leaf_index: '0',
        message_id: `\\x${'0'.repeat(64)}`,
        block_number: '1',
      });
      const second = (
        await request(pageQuery, { domain: 1, hook, from: first.next_index })
      ).merkle_tree_insertions;
      assert.deepEqual(
        second.insertions.map((row: { leaf_index: string }) => row.leaf_index),
        ['1000'],
      );
      assert.equal(second.next_index, null);
      const empty = (await request(pageQuery, { domain: 1, hook, from: 1001 }))
        .merkle_tree_insertions;
      assert.deepEqual(empty, { insertions: [], next_index: null });

      const singleQuery = `query One($domain: bigint!, $hook: bytea!, $index: bigint!) {
      merkle_tree_insertion(domain: $domain, merkle_tree_hook: $hook, leaf_index: $index) {
        domain merkle_tree_hook leaf_index message_id block_number
      }
    }`;
      const single = (await request(singleQuery, { domain: 1, hook, index: 0 }))
        .merkle_tree_insertion;
      assert.deepEqual(single, first.insertions[0]);
      for (const index of [1001, 9999]) {
        assert.equal(
          (await request(singleQuery, { domain: 1, hook, index }))
            .merkle_tree_insertion,
          null,
        );
      }
      const otherHook = (
        await request(singleQuery, {
          domain: 1,
          hook: `0x${'22'.repeat(20)}`,
          index: 0,
        })
      ).merkle_tree_insertion;
      assert.equal(otherHook.message_id, `\\x${'22'.repeat(32)}`);
      const otherDomain = (
        await request(singleQuery, { domain: 2, hook, index: 0 })
      ).merkle_tree_insertion;
      assert.equal(otherDomain.message_id, `\\x${'33'.repeat(32)}`);

      const boundary = (
        await request(pageQuery, {
          domain: '4294967295',
          hook,
          from: '2147483647',
          limit: 2,
        })
      ).merkle_tree_insertions;
      assert.deepEqual(
        boundary.insertions.map(
          (row: { leaf_index: string }) => row.leaf_index,
        ),
        ['2147483647', '2147483648'],
      );
      assert.equal(boundary.next_index, '4294967295');
      const last = (
        await request(pageQuery, {
          domain: '4294967295',
          hook,
          from: boundary.next_index,
        })
      ).merkle_tree_insertions;
      assert.equal(last.insertions[0].domain, '4294967295');
      assert.equal(last.insertions[0].leaf_index, '4294967295');
      assert.equal(last.next_index, null);
      assert.deepEqual(
        (
          await request(singleQuery, {
            domain: '4294967295',
            hook,
            index: '4294967295',
          })
        ).merkle_tree_insertion,
        last.insertions[0],
      );
    } finally {
      await app.close();
      await client.end();
    }
  },
);
