import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { EventDatabase } from './event-websocket.js';
import { rawData } from './websocket-data.js';

import pg from 'pg';

import { PROVISIONAL_MESSAGE_QUERY } from './provisional-message.js';
import { ScraperDbService } from '../scraperdb/scraperdb.service.js';
import { buildSelect } from '../scraperdb/sql.js';

type PlanNode = {
  'CTE Name'?: string;
  Alias?: string;
  'Actual Loops': number;
  Plans?: PlanNode[];
};
function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

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
      await t.test(
        'keeps WebSocket SQL flat across 100 subscribers and matches the confirmation SQL',
        async () => {
          await db.query('BEGIN');
          try {
            await checkMessageFanout(db);
          } finally {
            await db.query('ROLLBACK');
          }
        },
      );
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
      await db.query(`
        CREATE TEMP VIEW confirmed_delivered_message AS SELECT event.* FROM delivered_message event
          LEFT JOIN scraper_head head ON head.domain=event.domain
          WHERE event.block_number IS NULL OR event.block_number<=coalesce(head.confirmed_height,9223372036854775807);
        CREATE TEMP VIEW confirmed_gas_payment AS SELECT event.* FROM gas_payment event
          LEFT JOIN scraper_head head ON head.domain=event.domain
          WHERE event.block_number IS NULL OR event.block_number<=coalesce(head.confirmed_height,9223372036854775807);
      `);
      await db.query(
        readFileSync(
          new URL('./fixtures/message-view.sql', import.meta.url),
          'utf8',
        ),
      );
      // PostgreSQL does not auto-analyze temporary tables. Give the admission
      // check real fixture cardinalities before planning the history reads.
      await db.query(`ANALYZE domain, scraper_head, block, "transaction", raw_message_dispatch,
        message, delivered_message, gas_payment`);
      let lastQuery: { sql: string; values?: unknown[] } = { sql: '' };
      let lastRows: Record<string, unknown>[] = [];
      const service = new ScraperDbService({
        async query(sql, values) {
          lastQuery = { sql, values };
          lastRows = (await db.query(sql, values)).rows;
          return lastRows;
        },
      });

      const ids = (rows: Record<string, unknown>[]) =>
        rows.map((row) => row.id);
      await t.test(
        'preserves canonical defaults, frontier boundaries, and selection semantics',
        async () => {
          for (const confirmations of [undefined, null])
            assert.deepEqual(
              ids(await service.selectMessages({ confirmations })),
              ['2'],
            );
          const zero = await service.selectMessages({
            confirmations: 0,
            order_by: { id: 'asc' },
          });
          assert.deepEqual(ids(zero), ['1', '2']);
          assert(zero.every((row) => row.is_provisional === true));
          assert.equal(zero[1].total_payment, '300');
          const before = await service.selectMessages({ confirmations: 3 });
          assert.equal(before.length, 1);
          assert.equal(before[0].is_delivered, false);
          assert.equal(before[0].total_payment, '0');
          assert.deepEqual(
            ids(
              await service.selectMessages({
                confirmations: 0,
                where: { origin_domain_id: { _eq: 1 } },
                columns: ['id'],
                order_by: { send_occurred_at: 'desc' },
                limit: 1,
              }),
            ),
            ['1'],
          );
          assert.deepEqual(
            await service.selectMessages({
              where: { is_provisional: { _eq: true } },
            }),
            [],
          );
          const query = buildSelect('message_view', {
            where: { msg_id: { _in: ['\\x02'] } },
          });
          assert.equal(
            (await db.query(query.sql, query.values)).rows[0].is_provisional,
            false,
          );
        },
      );

      await t.test(
        'deduplicates before DISTINCT and limits; raw IDs never become history cursors',
        async () => {
          await db.query('BEGIN');
          try {
            await db.query(`
            UPDATE scraper_head SET confirmed_height=10, head_height=13, indexed_height=13;
            INSERT INTO gas_payment VALUES (3,decode('02','hex'),1,10,20,13);
            INSERT INTO message VALUES (1,decode('01','hex'),0,1,2,now(),decode('bb','hex'),decode('cc','hex'),decode('ee','hex'),1,null);
            INSERT INTO "transaction"(id,block_id,hash) VALUES (1,1,decode('cc','hex'));
          `);
            const rows = await service.selectMessages({
              confirmations: 0,
              distinct_on: ['sender'],
              order_by: [{ sender: 'asc' }, { id: 'desc' }],
              limit: 1,
            });
            assert.equal(rows.length, 1);
            assert.deepEqual(rows[0].msg_id, Buffer.from('02', 'hex'));
            assert.deepEqual(
              (
                await service.selectMessages({
                  confirmations: 0,
                  order_by: { id: 'asc' },
                })
              ).map((row) => row.is_provisional),
              [false, true],
            );
            await db.query(`
            UPDATE scraper_head SET confirmed_height=5;
            INSERT INTO raw_message_dispatch VALUES (2,decode('03','hex'),3,1,2,now(),null,null,null,decode('cc','hex'),decode('aa','hex'),10,null);
          `);
            const mixed = await service.selectMessages({ confirmations: 0 });
            assert.equal(mixed.filter((row) => row.id === '2').length, 2);
            await assert.rejects(
              service.selectMessages({
                confirmations: 0,
                cursor: [{ initial_value: { id: 2 }, ordering: 'DESC' }],
              }),
              /cursor is unsupported/,
            );
            assert.deepEqual(
              ids(
                await service.selectMessages({
                  cursor: [{ initial_value: { id: 3 }, ordering: 'DESC' }],
                  order_by: { id: 'desc' },
                  limit: 1,
                }),
              ),
              ['2'],
            );
          } finally {
            await db.query('ROLLBACK');
          }
        },
      );

      await t.test(
        'rebuilds unmatched raw hashes from canonical origins without losing nullable origins',
        async () => {
          await db.query('BEGIN');
          try {
            await db.query(`
            INSERT INTO message VALUES
              (1001,decode('11','hex'),11,2,1,now(),null,null,null,null,null),
              (1006,decode('16','hex'),16,2,1,now(),null,null,null,2,null);
            INSERT INTO raw_message_dispatch VALUES
              (1006,decode('16','hex'),16,2,1,now(),null,null,null,decode('dd','hex'),decode('ff','hex'),20,null);
            INSERT INTO gas_payment VALUES
              (1001,decode('11','hex'),1,1,1,10), (1006,decode('16','hex'),1,1,1,10);
            INSERT INTO delivered_message VALUES
              (1006,decode('16','hex'),1,now(),null,null,10,null,null);
          `);
            for (const msgId of ['11', '16']) {
              const [row] = await service.selectMessages({
                confirmations: 0,
                where: {
                  _and: [{ msg_id: { _eq: Buffer.from(msgId, 'hex') } }],
                },
              });
              assert(row);
              assert.equal(row.is_provisional, msgId === '16');
              if (msgId === '16') {
                assert.equal(row.total_payment, '1');
                assert.equal(row.is_delivered, true);
                assert.deepEqual(
                  row.origin_block_hash,
                  Buffer.from('bb', 'hex'),
                );
              }
            }
            const [strict] = await service.selectMessages({
              confirmations: 3,
              where: { msg_id: { _in: [Buffer.from('16', 'hex')] } },
            });
            assert.equal(strict.is_delivered, false);
            assert.equal(strict.total_payment, '0');
          } finally {
            await db.query('ROLLBACK');
          }
        },
      );

      await t.test(
        'keeps canonical IDs and bodies, and orders reloads by send time',
        async () => {
          await db.query('BEGIN');
          try {
            await db.query(`
            INSERT INTO message VALUES (100,decode('01','hex'),0,1,2,now(),null,null,null,null,decode('99','hex'));
            UPDATE delivered_message SET block_number=4 WHERE domain=1;
            UPDATE gas_payment SET block_number=4 WHERE domain=1;
          `);
            const [row] = await service.selectMessages({
              confirmations: 0,
              where: {
                msg_id: { _eq: Buffer.from('01', 'hex') },
                message_body: { _eq: Buffer.from('99', 'hex') },
              },
            });
            assert.equal(row.id, '100');
            assert.deepEqual(row.message_body, Buffer.from('99', 'hex'));
            const [live] = await service.selectMessages({
              confirmations: 0,
              where: { is_provisional: { _eq: true } },
              order_by: [{ send_occurred_at: 'desc' }, { id: 'desc' }],
              limit: 1,
            });
            assert.equal(live.id, '100');
            await db.query('INSERT INTO scraper_head VALUES (2,20,22,22)');
            assert.deepEqual(
              await service.selectMessages({ confirmations: 3 }),
              [],
            );
          } finally {
            await db.query('ROLLBACK');
          }
          await db.query(
            `INSERT INTO message VALUES (100,decode('01','hex'),0,1,2,now(),null,null,null,null,null);
             UPDATE scraper_head SET confirmed_height=indexed_height`,
          );
          const caughtUp = await service.selectMessages({ confirmations: 0 });
          assert.equal(caughtUp.length, 2);
          assert(caughtUp.every((row) => row.is_provisional === false));
        },
      );

      await t.test(
        'excludes canonical IDs without rebuilding or materializing the wide projection',
        async () => {
          await db.query('BEGIN');
          try {
            await db.query(`
            UPDATE scraper_head SET confirmed_height=0;
            INSERT INTO raw_message_dispatch
              SELECT id, decode(lpad(to_hex(id),8,'0'),'hex'), id,1,2,now(),decode('bb','hex'),null,null,
                null,decode('aa','hex'),10,null FROM generate_series(100,226) id;
            INSERT INTO message(id,msg_id,origin,destination,sender)
              SELECT id+10000,msg_id,1,2,sender FROM raw_message_dispatch WHERE id>=100;
            ANALYZE raw_message_dispatch; ANALYZE message;
          `);
            for (const where of [
              undefined,
              { sender: { _eq: Buffer.from('ff', 'hex') } },
            ]) {
              const rows = await service.selectMessages({
                confirmations: 0,
                where,
              });
              assert.equal(rows.length, where ? 0 : 129);
              const result = await db.query<{
                'QUERY PLAN': { Plan: PlanNode }[];
              }>(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${lastQuery.sql}`,
                lastQuery.values,
              );
              const nodes = planNodes(result.rows[0]['QUERY PLAN'][0].Plan);
              assert(
                !nodes.some(
                  (node) => node['CTE Name'] === 'affected_projection',
                ),
                'the wide projection must inline so filters reach dispatches',
              );
              const paymentLoops = nodes
                .filter((node) => node.Alias === 'payment')
                .reduce((sum, node) => sum + node['Actual Loops'], 0);
              assert.equal(
                paymentLoops,
                where ? 0 : 129,
                'payment work runs once per projected message, never for canonical exclusion',
              );
            }
          } finally {
            await db.query('ROLLBACK');
          }
        },
      );

      await t.test(
        'bounds backlog candidates before projection while keeping exact lookups available',
        async () => {
          await db.query('BEGIN');
          try {
            await db.query(`
            UPDATE scraper_head SET confirmed_height=0;
            INSERT INTO gas_payment SELECT id, decode(lpad(to_hex(id),8,'0'),'hex'), 1, 1, 1, 10
              FROM generate_series(10000,20001) id;
          `);
            await assert.rejects(
              service.selectMessages({ confirmations: 0 }),
              /10000 affected events/,
            );
            assert.equal(
              lastRows[0].message_ids,
              null,
              'overflow IDs must remain in PostgreSQL rather than being transferred',
            );
            const rows = await service.selectMessages({
              confirmations: 0,
              where: {
                _or: [
                  { msg_id: { _eq: Buffer.from('01', 'hex') } },
                  { msg_id: { _in: [Buffer.from('02', 'hex')] } },
                ],
              },
            });
            assert.equal(rows.length, 2);
          } finally {
            await db.query('ROLLBACK');
          }
        },
      );
    } finally {
      await db.end();
    }
  },
);

type Frame = { type: string; data?: Record<string, unknown>; height?: string };

async function checkMessageFanout(db: pg.Client) {
  process.env.DATABASE_URL ??= 'postgresql://localhost/scraper_test';
  const { EventWebSocketServer } = await import('./event-websocket.js');
  const id = '\\x' + '02'.repeat(32);
  const hash = 'ab'.repeat(32);
  await db.query(`ALTER TABLE scraper_head ADD COLUMN indexed_hash bytea;
    UPDATE scraper_head SET head_height=1010, indexed_height=1010, indexed_hash=decode(repeat('ab',32),'hex');
    UPDATE message SET msg_id=decode(repeat('02',32),'hex');
    UPDATE delivered_message SET msg_id=decode(repeat('02',32),'hex') WHERE id=2;
    UPDATE gas_payment SET msg_id=decode(repeat('02',32),'hex') WHERE id=2;
    INSERT INTO gas_payment SELECT h,decode(repeat('02',32),'hex'),1,h,999999999999999999999,h FROM unnest(ARRAY[11,991,1011]) h;
    INSERT INTO delivered_message VALUES (3,decode(repeat('02',32),'hex'),1,now(),null,null,1011,null,null);
    DELETE FROM delivered_message WHERE id=2;
    INSERT INTO scraper_head VALUES (3,5,1010,1010,decode(repeat('ab',32),'hex'));
    INSERT INTO gas_payment VALUES (3000,decode(repeat('02',32),'hex'),3,400,500,8)`);

  // Match the live pool's scalar parsers without mutating other fixture clients.
  const types = {
    getTypeParser(oid: number) {
      if ([17, 1114, 1186].includes(oid)) return (value: string) => value;
      return pg.types.getTypeParser(oid);
    },
  };
  const expected = new Map<string, Record<string, unknown>>();
  for (const n of [0, 20, 1000]) {
    for (const third of [true, false]) {
      const { rows } = await db.query({
        text: PROVISIONAL_MESSAGE_QUERY,
        values: [
          [id],
          third ? [1, 3] : [1],
          third ? [String(1011 - n), String(1010 - n)] : [String(1011 - n)],
        ],
        types,
      });
      const { payment_domain_ids: _, ...row } = rows[0];
      expected.set(`${n}:${third}`, row);
    }
  }
  assert.equal(expected.get('0:false')?.is_delivered, true);
  assert.equal(expected.get('20:false')?.is_delivered, false);
  assert.equal(expected.get('1000:false')?.num_payments, '2');
  assert.equal(expected.get('1000:true')?.num_payments, '3');

  async function replay(count: number) {
    await db.query('UPDATE "transaction" SET gas_price=NULL WHERE id=2');
    const queries = { snapshot: 0, range: 0, facts: 0 };
    let notify: Parameters<EventDatabase['listen']>[1] = () =>
      assert.fail('No listener');
    const server = new EventWebSocketServer({
      listen: async (_, handler) => {
        notify = handler;
        return async () => {};
      },
      async queryLive<T extends pg.QueryResultRow>(
        text: string,
        values?: unknown[],
      ) {
        if (text.includes('live_message_facts')) queries.facts++;
        else if (text.includes('confirmation_messages')) queries.range++;
        else if (text.includes('FROM scraper_head')) queries.snapshot++;
        else assert.fail('Unexpected live query: ' + text);
        return (await db.query<T>({ text, values, types })).rows;
      },
      queryValidator: async () => assert.fail('Unexpected validator read'),
    });
    const http = createServer();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert(address && typeof address !== 'string');
    await server.start(http);
    const clients: { socket: WebSocket; policy: string; frames: Frame[] }[] =
      [];
    const received = async (type: string, minimum = 1) => {
      const deadline = Date.now() + 5000;
      while (
        !clients.every(
          (c) => c.frames.filter((f) => f.type === type).length >= minimum,
        )
      ) {
        assert(Date.now() < deadline, 'Missing ' + type);
        await delay(5);
      }
    };
    const join = async (i: number) => {
      const n = [0, 20, 1000][i % 3];
      const ids =
        i % 2
          ? '&messageIds=0x' +
            id.slice(2) +
            ',0x' +
            i.toString(16).padStart(64, '0')
          : '';
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/messages?blocks=true&confirmations=${n}&domains=${i % 2 ? '3,2,1' : '1'}${ids}`,
        { headers: { 'cf-connecting-ip': `203.0.113.${i + 1}` } },
      );
      const frames: Frame[] = [];
      socket.on('message', (raw) => frames.push(JSON.parse(rawData(raw))));
      clients.push({ socket, policy: `${n}:${i % 2 === 1}`, frames });
      await received('ready');
    };
    const advance = (height: number, previous: number) =>
      notify(
        'scraper_head',
        JSON.stringify({
          domain: 1,
          headHeight: String(height),
          indexedHeight: String(height),
          previousIndexedHeight: String(previous),
          indexedHash: hash,
          confirmedHeight: '5',
          previousConfirmedHeight: '5',
        }),
      );
    try {
      for (let i = 0; i < count; i++) await join(i);
      assert.deepEqual(queries, { snapshot: 1, range: 0, facts: 0 });
      advance(1011, 1010);
      await received('message_upsert');
      for (const { policy, frames } of clients) {
        assert.equal(frames[0].type, 'ready');
        assert.deepEqual(
          frames.find((f) => f.type === 'message_upsert')?.data,
          expected.get(policy),
        );
      }
      // Late receipt enrichment stays a single ID read, including detail-page subscriptions.
      const waitUntil = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          assert(Date.now() < deadline, 'Expected all clients to update');
          await delay(5);
        }
      };
      await db.query('UPDATE "transaction" SET gas_price=1234 WHERE id=2');
      notify(
        'scraper_explorer_event',
        JSON.stringify({ messageId: id.slice(2) }),
      );
      await waitUntil(() =>
        clients.every((c) =>
          c.frames.some((f) => f.data?.origin_tx_gas_price === '1234'),
        ),
      );

      advance(1010, 1011);
      await received('rollback');
      await waitUntil(() =>
        clients.every(
          (c) =>
            c.frames.at(-1)?.type === 'message_upsert' &&
            c.frames.at(-1)?.data?.total_payment !==
              expected.get(c.policy)?.total_payment,
        ),
      );
      return queries;
    } finally {
      for (const { socket } of clients) socket.terminate();
      await server.stop();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }
  const single = await replay(1);
  assert.deepEqual(single, { snapshot: 1, range: 1, facts: 3 });
  assert.deepEqual(await replay(100), single);
}
