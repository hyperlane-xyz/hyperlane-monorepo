import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

const connectionString = process.env.SCRAPER_TEST_DATABASE_URL;

void it(
  'pages a domain range without gaps or duplicates across heights and sources',
  { skip: !connectionString },
  async () => {
    process.env.DATABASE_URL ??= 'postgres://localhost/scraper_changes_test';
    // Small pages put boundaries inside one height and between sources.
    process.env.EVENT_STREAM_BATCH_SIZE = '2';
    const { EventStore } = await import('./event-store.js');
    const { endOfHeight } = await import('./protocol.js');
    const db = new pg.Client({ connectionString });
    await db.connect();
    try {
      // Session-local tables: never alter an existing scraper database.
      await db.query(`
      CREATE TEMP TABLE raw_message_dispatch(id bigint, msg_id bytea, origin_domain integer, origin_block_height bigint);
      CREATE TEMP TABLE delivered_message(id bigint, msg_id bytea, domain integer, block_number bigint);
      CREATE TEMP TABLE gas_payment(id bigint, msg_id bytea, domain integer, block_number bigint);
      CREATE INDEX ON raw_message_dispatch(origin_domain, origin_block_height);
      CREATE INDEX ON delivered_message(domain, block_number);
      CREATE INDEX ON gas_payment(domain, block_number) WHERE block_number IS NOT NULL;
      -- Height 10 holds several rows per source, with ids out of insert order.
      INSERT INTO raw_message_dispatch VALUES
        (30,'\\x01',1,10),(4,'\\x02',1,10),(17,'\\x03',1,10),(5,'\\x04',1,9),
        (6,'\\x05',1,11),(7,'\\x06',1,21),(8,'\\x07',2,10);
      INSERT INTO delivered_message VALUES
        (9,'\\x08',1,10),(2,'\\x09',1,10),(20,'\\x13',1,10),(11,'\\x0a',1,12),(12,'\\x0b',2,10),
        (13,'\\x0f',1,13),(14,'\\x10',1,14),(18,'\\x11',1,15),(19,'\\x12',1,16);
      INSERT INTO raw_message_dispatch SELECT 100+h, decode(lpad(to_hex(100+h),2,'0'),'hex'), 1, h
        FROM generate_series(12,19) h;
      INSERT INTO gas_payment VALUES
        (40,'\\x01',1,10),(3,'\\x02',1,10),(15,'\\x0c',1,11),(16,'\\x0d',1,NULL),
        (1,'\\x0e',1,20);
    `);
      const store = new EventStore({
        queryLive: async <T extends pg.QueryResultRow>(
          text: string,
          values: unknown[] = [],
        ) => (await db.query<T>(text, values)).rows,
      });
      const pages: { height: bigint; id: string }[][] = [];
      for await (const page of store.messageChanges(1, endOfHeight(9n), 20n)) {
        pages.push(page);
        // A cursor that stops advancing must fail here, not hang the suite.
        assert.ok(pages.length <= 50, 'Page cursor did not advance');
      }
      const { rows } = await db.query<{ height: string; msg_id: string }>(`
        SELECT * FROM (
          SELECT origin_block_height AS height, 0 AS source, id, msg_id FROM raw_message_dispatch WHERE origin_domain=1
          UNION ALL SELECT block_number, 1, id, msg_id FROM delivered_message WHERE domain=1
          UNION ALL SELECT block_number, 2, id, msg_id FROM gas_payment WHERE domain=1
        ) c WHERE height>9 AND height<=20 ORDER BY height, source, id`);
      assert.ok(pages.length > 3, 'Expected several pages');
      assert.ok(pages.every((page) => page.length <= 2));
      assert.deepEqual(
        pages.flat().map(({ height, id }) => [String(height), id]),
        rows.map(({ height, msg_id }) => [height, msg_id]),
      );
    } finally {
      await db.end();
    }
  },
);
