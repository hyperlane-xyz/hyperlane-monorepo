import assert from 'node:assert/strict';
import { it } from 'node:test';

import pg from 'pg';

import { PROVISIONAL_MESSAGE_QUERY } from './provisional-message.js';

// Opt-in PostgreSQL regression: uses session-local tables, never persistent data.
const connectionString = process.env.SCRAPER_TEST_DATABASE_URL;
void it(
  'projects mixed-chain and legacy messages at independent frontiers',
  {
    skip: !connectionString,
  },
  async () => {
    const db = new pg.Client({ connectionString });
    await db.connect();
    try {
      await db.query(`
      CREATE TEMP TABLE domain(id integer, chain_id bigint, name text);
      CREATE TEMP TABLE scraper_head(domain integer, confirmed_height bigint);
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
      INSERT INTO scraper_head VALUES (1,5);
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
      assert.equal(legacy.is_delivered, true);
      assert.equal(legacy.total_payment, '300');

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
    } finally {
      await db.end();
    }
  },
);
