import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

import { PROVISIONAL_MESSAGE_QUERY } from './provisional-message.js';
import { ScraperDbService } from '../scraperdb/scraperdb.service.js';

// Opt-in PostgreSQL regression: uses session-local tables, never persistent data.
const connectionString = process.env.SCRAPER_TEST_DATABASE_URL;
void it(
  'projects mixed-chain and legacy messages at independent frontiers',
  {
    skip: !connectionString,
  },
  async (t) => {
    const db = new pg.Client({ connectionString });
    await db.connect();
    try {
      await db.query(`
      CREATE TEMP TABLE domain(id integer, chain_id bigint, name text);
      CREATE TEMP TABLE scraper_head(domain integer, confirmed_height bigint, head_height bigint, indexed_height bigint);
      CREATE TEMP TABLE block(id bigint, domain integer, hash bytea, height bigint, timestamp timestamp);
      CREATE TEMP TABLE "transaction"(id bigint, block_id bigint, hash bytea, gas_limit numeric,
        max_priority_fee_per_gas numeric, max_fee_per_gas numeric, gas_price numeric,
        effective_gas_price numeric, nonce bigint, sender bytea, recipient bytea,
        gas_used numeric, cumulative_gas_used numeric);
      CREATE TEMP TABLE raw_message_dispatch(id bigint, msg_id bytea, nonce integer,
        origin_domain integer, destination_domain integer, time_created timestamp,
        sender bytea, recipient bytea, origin_mailbox bytea, origin_tx_hash bytea,
        origin_block_hash bytea, origin_block_height bigint, msg_body bytea);
      CREATE TEMP TABLE message(id bigint, msg_id bytea, nonce integer, origin integer,
        destination integer, time_created timestamp, sender bytea, recipient bytea,
        origin_mailbox bytea, origin_tx_id bigint, msg_body bytea);
      CREATE TEMP TABLE delivered_message(id bigint, msg_id bytea, domain integer,
        time_created timestamp, destination_mailbox bytea, destination_tx_id bigint,
        block_number bigint, block_hash bytea, transaction_hash bytea);
      CREATE TEMP TABLE gas_payment(id bigint, msg_id bytea, domain integer,
        payment numeric, gas_amount numeric, block_number bigint);
      INSERT INTO domain VALUES (1,1,'near-head'),(2,2,'legacy');
      INSERT INTO scraper_head VALUES (1,5,12,10);
      INSERT INTO block VALUES (1,1,decode('aa','hex'),10,now()),
        (2,2,decode('bb','hex'),20,now());
      INSERT INTO "transaction"(id,block_id,hash) VALUES (2,2,decode('dd','hex'));
      INSERT INTO raw_message_dispatch VALUES (1,decode('01','hex'),0,1,2,now(),
        decode('bb','hex'),decode('cc','hex'),decode('ee','hex'),decode('cc','hex'),
        decode('aa','hex'),10,null);
      -- Legacy message has no raw dispatch. Its delivery is on the near-head chain.
      INSERT INTO message VALUES (2,decode('02','hex'),1,2,1,now(),decode('bb','hex'),
        decode('cc','hex'),decode('ee','hex'),2,null);
      INSERT INTO delivered_message VALUES (1,decode('01','hex'),2,now(),null,2,null,null,null),
        (2,decode('02','hex'),1,now(),null,null,10,decode('aa','hex'),decode('cc','hex'));
      INSERT INTO gas_payment VALUES (1,decode('01','hex'),2,100,200,null),
        (2,decode('02','hex'),1,300,400,10);
    `);
      const project = async (height?: string) =>
        (
          await db.query<{
            origin_domain_id: number;
            is_delivered: boolean;
            payment_domain_ids: number[] | null;
            total_payment: string;
          }>(PROVISIONAL_MESSAGE_QUERY, [
            ['\\x01', '\\x02'],
            height === undefined ? [] : [1],
            height === undefined ? [] : [height],
          ])
        ).rows;

      let rows = await project('9');
      assert.equal(
        rows.length,
        1,
        'near-head dispatch must wait for its requested frontier',
      );
      assert.equal(rows[0].origin_domain_id, 2);
      assert.equal(
        rows[0].is_delivered,
        false,
        'legacy origin does not bypass destination confirmations',
      );
      assert.equal(rows[0].total_payment, '0');

      rows = await project('10');
      assert.equal(rows.length, 2);
      const nearHead = rows.find((row) => row.origin_domain_id === 1);
      const legacy = rows.find((row) => row.origin_domain_id === 2);
      assert(nearHead && legacy);
      assert.equal(
        nearHead.is_delivered,
        true,
        'canonical destination updates remain visible',
      );
      assert.equal(nearHead.total_payment, '100');
      assert.deepEqual(nearHead.payment_domain_ids, [2]);
      assert.equal(legacy.is_delivered, true);
      assert.equal(legacy.total_payment, '300');
      assert.deepEqual(legacy.payment_domain_ids, [1]);

      rows = await project('9');
      assert.equal(rows.length, 1, 'rollback removes the provisional origin');
      assert.equal(
        rows[0].is_delivered,
        false,
        'rollback also undoes delivery on a legacy message',
      );
      assert.equal(rows[0].total_payment, '0');

      rows = await project();
      assert.equal(
        rows.length,
        1,
        'canonical-only clients use scraper finality on unselected chains',
      );
      assert.equal(rows[0].origin_domain_id, 2);
      assert.equal(rows[0].is_delivered, false);
      // A canonical view over the same fixture, including the legacy message.
      const canonicalProjection = PROVISIONAL_MESSAGE_QUERY.replaceAll(
        '$1::bytea[]',
        "ARRAY[decode('01','hex'),decode('02','hex')]",
      )
        .replaceAll('$2::integer[]', 'ARRAY[]::integer[]')
        .replaceAll('$3::bigint[]', 'ARRAY[]::bigint[]');
      await db.query(`CREATE TEMP VIEW message_view AS ${canonicalProjection}`);
      const service = new ScraperDbService({
        async query(sql, values) {
          return (await db.query(sql, values)).rows;
        },
      });

      await t.test(
        'preserves default/null finality and includes provisional rows at zero',
        async () => {
          for (const confirmations of [undefined, null]) {
            const canonical = await service.selectMessages({
              confirmations,
              columns: ['id', 'is_provisional'],
            });
            assert.deepEqual(
              canonical.map((row) => row.id),
              ['2'],
            );
          }
          const snapshot = await service.selectMessages({
            confirmations: 0,
            columns: ['id', 'is_provisional'],
            order_by: { id: 'asc' },
          });
          assert.deepEqual(
            snapshot.map((row) => row.id),
            ['1', '2'],
          );
          assert(snapshot.every((row) => row.is_provisional === true));
          assert.equal(
            (await service.selectMessages({ confirmations: 3 })).length,
            1,
          );
        },
      );

      await t.test(
        'filters and orders by fields absent from the selection',
        async () => {
          const filtered = await service.selectMessages({
            confirmations: 0,
            columns: ['msg_id'],
            where: { origin_domain_id: { _eq: 1 } },
            order_by: { id: 'desc' },
            limit: 1,
          });
          assert.equal(filtered.length, 1);
          assert.deepEqual(filtered[0].msg_id, Buffer.from('01', 'hex'));
          const page = await service.selectMessages({
            confirmations: 0,
            columns: ['msg_id'],
            cursor: [{ initial_value: { id: 2 }, ordering: 'DESC' }],
            limit: 1,
          });
          assert.deepEqual(
            page.map((row) => row.msg_id),
            [Buffer.from('01', 'hex')],
          );
        },
      );

      await t.test(
        'reprojects delivery and payment at the requested boundary',
        async () => {
          const snapshot = await service.selectMessages({
            confirmations: 2,
            order_by: { id: 'asc' },
          });
          assert.equal(snapshot.length, 2);
          assert.equal(snapshot[1].is_delivered, true);
          assert.equal(snapshot[1].total_payment, '300');
          const before = await service.selectMessages({ confirmations: 3 });
          assert.equal(before.length, 1);
          assert.equal(before[0].is_delivered, false);
          assert.equal(before[0].total_payment, '0');
        },
      );

      await t.test(
        'deduplicates across canonical and projected branches before limiting',
        async () => {
          // Keep message 01 canonical while a newer payment on 02 is provisional.
          await db.query(`
            UPDATE scraper_head SET confirmed_height=10, head_height=13, indexed_height=13;
            INSERT INTO gas_payment VALUES (3,decode('02','hex'),1,10,20,13);
          `);
          const snapshot = await service.selectMessages({
            confirmations: 0,
            columns: ['sender', 'msg_id', 'is_provisional'],
            distinct_on: ['sender'],
            order_by: [{ sender: 'asc' }, { id: 'desc' }],
            limit: 1,
          });
          assert.equal(snapshot.length, 1);
          assert.deepEqual(snapshot[0].msg_id, Buffer.from('02', 'hex'));
          assert.equal(snapshot[0].is_provisional, true);
          const mixed = await service.selectMessages({
            confirmations: 0,
            columns: ['id', 'is_provisional'],
            order_by: { id: 'asc' },
          });
          assert.deepEqual(
            mixed.map((row) => row.is_provisional),
            [false, true],
          );
          await db.query(
            'UPDATE scraper_head SET confirmed_height=5, head_height=12, indexed_height=10',
          );
        },
      );

      await t.test(
        'reload includes raw IDs below the canonical page without using them as cursors',
        async () => {
          await db.query(`
          UPDATE delivered_message SET block_number=4 WHERE domain=1;
          UPDATE gas_payment SET block_number=4 WHERE domain=1;
          UPDATE block SET timestamp=now()+interval '1 minute' WHERE domain=1;
        `);
          const canonical = await service.selectMessages({
            columns: ['id'],
            order_by: { id: 'desc' },
            limit: 1,
          });
          const provisional = await service.selectMessages({
            confirmations: 0,
            columns: ['id', 'msg_id', 'is_provisional', 'origin_block_height'],
            where: { is_provisional: { _eq: true } },
            order_by: [{ send_occurred_at: 'desc' }, { id: 'desc' }],
            limit: 1,
          });
          assert.deepEqual(
            canonical.map((row) => row.id),
            ['2'],
          );
          assert.deepEqual(
            provisional.map((row) => row.id),
            ['1'],
          );
          assert.equal(provisional[0].is_provisional, true);
          assert.equal(provisional[0].origin_block_height, '10');
          assert.deepEqual(
            await service.selectMessages({
              where: { is_provisional: { _eq: true } },
            }),
            [],
            'omitting confirmations must not expose provisional rows',
          );
          await db.query(`
          UPDATE delivered_message SET block_number=10 WHERE domain=1;
          UPDATE gas_payment SET block_number=10 WHERE domain=1;
        `);
        },
      );

      await t.test(
        'projection keeps the canonical ID when a raw dispatch is already canonical',
        async () => {
          await db.query(`
          INSERT INTO message VALUES (100,decode('01','hex'),0,1,2,now(),
            decode('bb','hex'),decode('cc','hex'),decode('ee','hex'),null,null);
        `);
          const snapshot = await service.selectMessages({
            confirmations: 0,
            columns: ['id', 'msg_id'],
            where: { msg_id: { _eq: Buffer.from('01', 'hex') } },
          });
          assert.deepEqual(
            snapshot.map((row) => row.id),
            ['100'],
          );
        },
      );

      await t.test(
        'excludes legacy origins when a stricter frontier precedes their dispatch',
        async () => {
          await db.query('INSERT INTO scraper_head VALUES (2,20,22,22)');
          const snapshot = await service.selectMessages({ confirmations: 3 });
          assert.equal(snapshot.length, 0);
        },
      );

      await t.test(
        'returns canonical flags after the frontier catches up',
        async () => {
          await db.query(
            'UPDATE scraper_head SET confirmed_height=indexed_height',
          );
          const snapshot = await service.selectMessages({ confirmations: 0 });
          assert.equal(snapshot.length, 2);
          assert(snapshot.every((row) => row.is_provisional === false));
        },
      );
    } finally {
      await db.end();
    }
  },
);
