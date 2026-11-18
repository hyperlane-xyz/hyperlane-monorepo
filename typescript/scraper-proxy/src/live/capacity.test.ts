import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { QueryResultRow } from 'pg';
import { WebSocket } from 'ws';

import type { EventDatabase } from './event-websocket.js';
import { rawData } from './websocket-data.js';

// Opt-in socket/fanout load check. SQL responses are synthetic; database-backed
// compatibility and rollback tests live in event-source.postgres.test.ts.
void it(
  'serves 500 message and 2000 validator sockets with isolated constant read counts',
  { skip: process.env.SCRAPER_CAPACITY_TEST !== '1', timeout: 90_000 },
  async (t) => {
    process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused';
    const { EventWebSocketServer } = await import('./event-websocket.js');
    const http = createServer();
    let notify: Parameters<EventDatabase['listen']>[1] = () =>
      assert.fail('listener unavailable');
    const reads = { agent: 0, validators: 0, messages: 0 };
    const hash = 'ab'.repeat(32);
    const address = `\\x${'11'.repeat(20)}`;
    const messageId = `\\x${'22'.repeat(32)}`;
    function query(sql: string, values: unknown[]) {
      if (sql.startsWith('SELECT id FROM domain')) return [{ id: 1 }];
      if (sql.includes('LEFT JOIN LATERAL'))
        return [
          {
            domain: 1,
            confirmations: 0,
            head_height: '1000',
            indexed_height: '1000',
            confirmed_height: '900',
            height: '1000',
            hash,
            mailbox: address,
            merkle_tree_hook: address,
            interchain_gas_paymaster: address,
          },
        ];
      if (sql.includes('confirmation_events'))
        return [
          {
            domain: 1,
            merkle_tree_hook: address,
            leaf_index: values[3],
            message_id: messageId,
            block_number: values[3],
            block_hash: hash,
            frontier_height: values[3],
            frontier_id: values[3],
          },
        ];
      if (sql.includes('"message_view"'))
        return [
          {
            id: '42',
            msg_id: messageId,
            origin_domain_id: 1,
            send_occurred_at: '2026-11-18T12:00:00Z',
            is_delivered: false,
            msg_body: `\\x${'ab'.repeat(256)}`,
          },
        ];
      return [];
    }
    const db: EventDatabase = {
      async listen(_channels, handler) {
        notify = handler;
        return async () => {};
      },
      async queryLive<T extends QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ): Promise<T[]> {
        if (sql.includes('confirmation_events')) reads.agent++;
        if (sql.includes('"message_view"')) reads.messages++;
        return rows<T>(query(sql, values));
      },
      async queryValidator<T extends QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ): Promise<T[]> {
        if (sql.includes('confirmation_events')) reads.validators++;
        return rows<T>(query(sql, values));
      },
    };
    const events = new EventWebSocketServer(db);
    const clients: { socket: WebSocket; updates: number; route: string }[] = [];
    const rssBefore = process.memoryUsage().rss;
    try {
      await new Promise<void>((resolve) =>
        http.listen(0, '127.0.0.1', resolve),
      );
      const serverAddress = http.address();
      assert(serverAddress && typeof serverAddress !== 'string');
      const base = `ws://127.0.0.1:${serverAddress.port}`;
      await events.start(http);
      async function connect(route: string, index: number) {
        const socket = new WebSocket(
          `${base}/${route}${route === 'validators' ? '?domain=1&confirmations=0' : ''}`,
          {
            headers: {
              'cf-connecting-ip': `203.0.113.${1 + (index % (route === 'validators' ? 20 : 100))}`,
            },
          },
        );
        const client = { socket, updates: 0, route };
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          socket.on('error', reject);
          socket.on('message', (data) => {
            const frame: unknown = JSON.parse(rawData(data));
            assert(frame && typeof frame === 'object' && 'type' in frame);
            if (frame.type === 'event' || frame.type === 'message_upsert')
              client.updates++;
            if (route === 'agents' && frame.type === 'ready')
              socket.send(
                JSON.stringify({
                  type: 'subscribe',
                  streams: [
                    {
                      eventType: 'merkle_tree_insertion',
                      domains: [1],
                      confirmations: 0,
                    },
                  ],
                }),
              );
            if (frame.type === (route === 'messages' ? 'ready' : 'live_start'))
              resolve();
          });
        });
      }
      await connect('agents', 0);
      for (const [route, count] of [
        ['messages', 500],
        ['validators', 2000],
      ] satisfies [string, number][]) {
        for (let start = 0; start < count; start += 8)
          await Promise.all(
            Array.from({ length: Math.min(8, count - start) }, (_, i) =>
              connect(route, start + i),
            ),
          );
      }
      assert.deepEqual(events.metricsSnapshot().connections, {
        agent: 1,
        messages: 500,
        validators: 2000,
      });
      const extraValidator = new WebSocket(`${base}/validators?domain=1`, {
        headers: { 'cf-connecting-ip': '203.0.113.200' },
      });
      extraValidator.on('error', () => {});
      const status = await new Promise<number | undefined>((resolve) =>
        extraValidator.once('unexpected-response', (_request, response) => {
          response.resume();
          resolve(response.statusCode);
          extraValidator.terminate();
        }),
      );
      assert.equal(status, 503);
      const extraMessage = new WebSocket(`${base}/messages`, {
        headers: { 'cf-connecting-ip': '203.0.113.201' },
      });
      assert.equal(
        await new Promise<number>((resolve) =>
          extraMessage.once('close', resolve),
        ),
        1013,
      );
      const latency: number[] = [];
      for (let round = 1; round <= 3; round++) {
        const start = performance.now();
        notify(
          'scraper_head',
          JSON.stringify({
            domain: 1,
            headHeight: String(1000 + round),
            indexedHeight: String(1000 + round),
            previousIndexedHeight: String(999 + round),
            confirmedHeight: '900',
            previousConfirmedHeight: '900',
          }),
        );
        notify(
          'scraper_explorer_event',
          JSON.stringify({ messageId: messageId.slice(2) }),
        );
        for (
          let attempt = 0;
          attempt < 1000 && clients.some((client) => client.updates < round);
          attempt++
        )
          await delay(10);
        assert(clients.every((client) => client.updates === round));
        assert(
          clients.every(
            (client) => client.socket.readyState === WebSocket.OPEN,
          ),
        );
        latency.push(Math.round(performance.now() - start));
      }
      assert.deepEqual(reads, { agent: 3, validators: 3, messages: 3 });
      t.diagnostic(
        JSON.stringify({
          connections: events.metricsSnapshot().connections,
          reads,
          fanoutMilliseconds: latency,
          rssDeltaMiB: Math.round(
            (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
          ),
          queues: events.metricsSnapshot().queues,
        }),
      );
    } finally {
      for (const client of clients) client.socket.terminate();
      await events.stop();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

// Match the generic database test adapters without assertions or any casts.
function rows<T extends QueryResultRow>(values: object[]): T[] {
  return values.map((value) => Object.assign(Object.create(null), value));
}
