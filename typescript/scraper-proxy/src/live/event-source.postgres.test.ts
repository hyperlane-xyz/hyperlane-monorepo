import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';
import { WebSocket } from 'ws';

import type { EventDatabase } from './event-websocket.js';
import { rawData } from './websocket-data.js';

const connectionString = process.env.SCRAPER_TEST_DATABASE_URL;

void it(
  'streams isolated agent/validator sources through PostgreSQL notifications and real sockets',
  { skip: !connectionString, timeout: 15_000 },
  async (t) => {
    process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused';
    const { EventWebSocketServer } = await import('./event-websocket.js');
    await import('../db/db.service.js'); // Use the production bytea/timestamp parsers.
    const db = new pg.Client({ connectionString });
    await db.connect();
    const http = createServer();
    const reads: { sql: string; values: unknown[] }[] = [];
    const database: EventDatabase = {
      async queryLive<T extends pg.QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ) {
        if (sql.includes('confirmation_events')) reads.push({ sql, values });
        return (await db.query<T>(sql, values)).rows;
      },
      async queryValidator<T extends pg.QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ) {
        return database.queryLive<T>(sql, values);
      },
      async listen(_channels, handler) {
        const listener = (notification: pg.Notification) =>
          handler(notification.channel, notification.payload);
        db.on('notification', listener);
        await db.query(
          'LISTEN scraper_head; LISTEN scraper_event; LISTEN scraper_explorer_event',
        );
        return async () => {
          db.off('notification', listener);
          await db.query('UNLISTEN *');
        };
      },
    };
    const events = new EventWebSocketServer(database);
    const clients: {
      socket: WebSocket;
      frames: Record<string, unknown>[];
      confirmations?: number;
      route: string;
    }[] = [];
    const emit = async (
      head: number,
      indexed: number,
      previous: number,
      confirmed = 80,
      previousConfirmed = confirmed,
    ) => {
      await db.query(
        'UPDATE scraper_head SET head_height=$1, indexed_height=$2, confirmed_height=$3',
        [head, indexed, confirmed],
      );
      await db.query('SELECT pg_notify($1,$2)', [
        'scraper_head',
        JSON.stringify({
          domain: 1,
          headHeight: String(head),
          indexedHeight: String(indexed),
          previousIndexedHeight: String(previous),
          confirmedHeight: String(confirmed),
          previousConfirmedHeight: String(previousConfirmed),
        }),
      ]);
    };
    t.after(async () => {
      for (const { socket } of clients) socket.terminate();
      const cleanup = await Promise.allSettled([
        events.stop(),
        http.listening
          ? new Promise<void>((resolve, reject) =>
              http.close((error) => (error ? reject(error) : resolve())),
            )
          : Promise.resolve(),
      ]);
      await db.end();
      for (const result of cleanup)
        if (result.status === 'rejected') throw result.reason;
    });
    // Session-local fixtures: no persistent schema or production data writes.
    await db.query(`
    CREATE TEMP TABLE domain(id integer PRIMARY KEY);
    INSERT INTO domain VALUES (1);
    CREATE TEMP TABLE scraper_head(domain integer PRIMARY KEY, head_height bigint, indexed_height bigint, confirmed_height bigint, healthy boolean, halted boolean, mailbox bytea, merkle_tree_hook bytea, interchain_gas_paymaster bytea);
    INSERT INTO scraper_head VALUES (1,100,100,80,true,false,decode(repeat('11',20),'hex'),decode(repeat('22',20),'hex'),decode(repeat('33',20),'hex'));
    CREATE TEMP TABLE scraper_checkpoint(domain integer, height bigint, hash bytea, PRIMARY KEY(domain,height));
    INSERT INTO scraper_checkpoint SELECT 1,n,decode(repeat('ab',32),'hex') FROM generate_series(70,105) n;
    CREATE TEMP TABLE merkle_tree_insertion(id bigint PRIMARY KEY, domain integer, merkle_tree_hook bytea, leaf_index bigint, message_id bytea, block_number bigint, block_hash bytea);
    CREATE INDEX ON merkle_tree_insertion(domain, block_number, id);
    INSERT INTO merkle_tree_insertion SELECT n,1,decode(repeat('22',20),'hex'),n,decode(repeat('aa',32),'hex'),n,decode(repeat('ab',32),'hex') FROM generate_series(98,100) n;
    CREATE TEMP VIEW confirmed_merkle_tree_insertion AS SELECT m.* FROM merkle_tree_insertion m JOIN scraper_head h USING(domain) WHERE m.block_number<=h.confirmed_height;
  `);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    assert(address && typeof address !== 'string');
    await events.start(http);
    for (const route of ['agents', 'validators']) {
      for (const confirmations of [undefined, 0, 2]) {
        const query =
          route === 'validators'
            ? `?domain=1${confirmations === undefined ? '' : `&confirmations=${confirmations}`}`
            : '';
        const socket = new WebSocket(
          `ws://127.0.0.1:${address.port}/${route}${query}`,
        );
        const frames: Record<string, unknown>[] = [];
        socket.on('message', (data) => {
          const frame: unknown = JSON.parse(rawData(data));
          assert(frame && typeof frame === 'object' && !Array.isArray(frame));
          frames.push(Object.fromEntries(Object.entries(frame)));
        });
        clients.push({ socket, frames, confirmations, route });
        await until(() => frames.some((frame) => frame.type === 'ready'));
        if (route === 'agents')
          socket.send(
            JSON.stringify({
              type: 'subscribe',
              streams: [
                {
                  eventType: 'merkle_tree_insertion',
                  domains: [1],
                  confirmations,
                },
              ],
            }),
          );
        await until(() => frames.some((frame) => frame.type === 'live_start'));
      }
    }
    const custom = clients.filter(
      (client) => client.confirmations !== undefined,
    );
    const canonical = clients.filter(
      (client) => client.confirmations === undefined,
    );
    const eventFrames = (client: (typeof clients)[number]) =>
      client.frames.filter((frame) => frame.type === 'event');
    assert.equal(reads.length, 0);
    assert.equal(events.metricsSnapshot().eventSource.ranges, 1);
    assert.equal(events.metricsSnapshot().validatorSource.ranges, 1);
    await db.query(
      "INSERT INTO merkle_tree_insertion VALUES (101,1,decode(repeat('22',20),'hex'),101,decode(repeat('aa',32),'hex'),101,decode(repeat('ab',32),'hex'))",
    );
    await emit(101, 101, 100);
    await until(() =>
      custom.every((client) => eventFrames(client).length === 1),
    );
    assert.equal(
      reads.length,
      4,
      'one prefix and one live extension per isolated route',
    );
    for (const client of custom)
      assert.equal(
        eventFrames(client)[0].height,
        client.confirmations === 0 ? '101' : '99',
      );
    assert(canonical.every((client) => eventFrames(client).length === 0));
    await emit(103, 101, 101);
    await until(() =>
      custom
        .filter((client) => client.confirmations === 2)
        .every((client) => eventFrames(client).length === 3),
    );
    assert.equal(
      reads.length,
      4,
      'maturing confirmations release cached events without another read',
    );
    await emit(103, 101, 101, 101, 80);
    await until(() =>
      canonical.every((client) => eventFrames(client).length === 4),
    );
    assert(
      canonical.every((client) =>
        eventFrames(client).every((frame) => frame.confirmations === undefined),
      ),
    );
    for (const confirmations of [undefined, 0, 2]) {
      const peers = clients.filter(
        (client) => client.confirmations === confirmations,
      );
      assert.deepEqual(
        eventFrames(peers[0]),
        eventFrames(peers[1]),
        'both routes preserve the same event protocol',
      );
    }
    await db.query('DELETE FROM merkle_tree_insertion WHERE block_number>99');
    await emit(101, 99, 101, 99, 101);
    await until(() =>
      custom.every((client) =>
        client.frames.some((frame) => frame.type === 'rollback'),
      ),
    );
    for (const client of custom) {
      const rollback = client.frames.find((frame) => frame.type === 'rollback');
      assert.equal(rollback?.fromHeight, '101');
      assert.equal(rollback?.toHeight, '99');
    }
    await db.query(
      "INSERT INTO merkle_tree_insertion VALUES (200,1,decode(repeat('22',20),'hex'),100,decode(repeat('bb',32),'hex'),100,decode(repeat('cd',32),'hex'))",
    );
    await emit(102, 100, 99, 99);
    await until(() =>
      custom.every(
        (client) =>
          eventFrames(client).at(-1)?.blockHash === `\\x${'cd'.repeat(32)}`,
      ),
    );
    assert.equal(
      reads.length,
      6,
      'replacement is read once per route across its confirmation policies',
    );
    assert(clients.every(({ socket }) => socket.readyState === WebSocket.OPEN));
  },
);

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for PostgreSQL-backed stream');
}
