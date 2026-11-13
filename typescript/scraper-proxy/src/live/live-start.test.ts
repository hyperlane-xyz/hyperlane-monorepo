import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

const connectionString = process.env.SCRAPER_TEST_DATABASE_URL;

void it(
  'reads healthy confirmed checkpoints with native heights, hashes and contract identities',
  {
    skip: !connectionString,
  },
  async () => {
    process.env.DATABASE_URL ??= 'postgres://localhost/scraper_live_start_test';
    const { EventStore } = await import('./event-store.js');
    const db = new pg.Client({ connectionString });
    await db.connect();
    try {
      // Session-local tables: never alter an existing scraper database.
      await db.query(`
      CREATE TEMP TABLE scraper_head (
        domain integer PRIMARY KEY, confirmed_height bigint, indexed_height bigint,
        mailbox bytea, merkle_tree_hook bytea, interchain_gas_paymaster bytea,
        healthy boolean, halted boolean, head_height bigint DEFAULT 120
      );
      CREATE TEMP TABLE scraper_checkpoint (
        domain integer, height bigint, hash bytea, PRIMARY KEY(domain,height)
      );
      INSERT INTO scraper_head
        SELECT domain, 100, 110, decode(repeat('11',20),'hex'),
          decode(repeat('22',32),'hex'), decode(repeat('33',32),'hex'),
          domain<>2, domain=3,120 FROM generate_series(1,6) domain;
      INSERT INTO scraper_checkpoint
        SELECT domain, 100, decode(repeat('ab',32),'hex') FROM generate_series(1,6) domain
        WHERE domain<>4;
      INSERT INTO scraper_checkpoint VALUES (1,110,decode(repeat('cd',32),'hex'));
      UPDATE scraper_head SET confirmed_height=0 WHERE domain=5;
      UPDATE scraper_checkpoint SET height=0 WHERE domain=5;
      INSERT INTO scraper_head VALUES (-2,9007199254740993,9007199254740993,
        decode(repeat('44',32),'hex'),decode(repeat('55',32),'hex'),decode(repeat('66',32),'hex'),true,false,9007199254740993);
      INSERT INTO scraper_checkpoint VALUES (-2,9007199254740993,decode(repeat('ef',32),'hex'));
    `);
      const store = new EventStore({
        async queryLive<T extends pg.QueryResultRow>(
          sql: string,
          values: unknown[] = [],
        ): Promise<T[]> {
          return (await db.query<T>(sql, values)).rows;
        },
      });
      const boundaries = await store.liveStartBoundaries(
        new Set([1, 2, 3, 4, 5, 4294967294]),
      );
      assert.deepEqual(
        [...boundaries.keys()].sort((a, b) => a - b),
        [1, 5, 4294967294],
      );
      assert.deepEqual(boundaries.get(1), {
        height: '100',
        hash: `0x${'ab'.repeat(32)}`,
        contracts: {
          dispatch: `0x${'11'.repeat(20)}`,
          delivery: `0x${'11'.repeat(20)}`,
          merkle_tree_insertion: `0x${'22'.repeat(32)}`,
          gas_payment: `0x${'33'.repeat(32)}`,
        },
      });
      assert.equal(boundaries.get(5)?.height, '0');
      assert.equal(boundaries.get(4294967294)?.height, '9007199254740993');
      assert.equal(
        boundaries.get(4294967294)?.contracts.dispatch,
        `0x${'44'.repeat(32)}`,
      );
      // FastPath uses its own frontier, capped by indexed progress. Sparse
      // native heights select the preceding checkpoint, never an invented hash.
      await db.query(
        "INSERT INTO scraper_checkpoint VALUES (1,108,decode(repeat('ef',32),'hex'))",
      );
      const custom = await store.confirmationHeads(
        new Set([1, 2, 3, 4, 5, 4294967294]),
        11,
      );
      assert.equal(custom.get(1)?.liveStart?.height, '108');
      assert.equal(custom.get(1)?.liveStart?.hash, `0x${'ef'.repeat(32)}`);
      assert.equal(custom.get(1)?.head, 120n);
      assert.equal(custom.get(2)?.liveStart, undefined);
      assert.equal(custom.get(3)?.liveStart, undefined);
      assert.equal(custom.get(4)?.liveStart, undefined);
      assert.equal(custom.get(5)?.liveStart?.height, '0');
      assert.equal(
        (await store.confirmationHeads(new Set([1]), 0)).get(1)?.liveStart
          ?.height,
        '110',
      );
      assert.equal(
        (await store.confirmationHeads(new Set([1]), 21)).get(1)?.liveStart,
        undefined,
      );
      assert.equal(
        (await store.confirmationHeads(new Set([4294967294]), 0)).get(
          4294967294,
        )?.liveStart?.height,
        '9007199254740993',
      );
      assert.equal((await store.liveStartBoundaries()).size, 4);
      await db.query(
        "UPDATE scraper_checkpoint SET hash=decode('ab','hex') WHERE domain=1 AND height=100",
      );
      const corrupt = await store.liveStartBoundaries(new Set([1, 5]));
      assert.equal(corrupt.has(1), false);
      assert.equal(corrupt.get(5)?.height, '0');
      assert.equal(
        (await store.confirmationHeads(new Set([1, 5]), 20)).get(1)?.liveStart,
        undefined,
      );
      await db.query(
        "UPDATE scraper_head SET mailbox=decode('aa','hex') WHERE domain=5",
      );
      assert.equal((await store.liveStartBoundaries(new Set([5]))).size, 0);
      assert.equal(
        (await store.confirmationHeads(new Set([5]), 0)).get(5)?.liveStart,
        undefined,
      );
    } finally {
      await db.end();
    }
  },
);
