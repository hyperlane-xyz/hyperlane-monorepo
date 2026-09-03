import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, it, type TestContext } from 'node:test';

import { WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';

import { metricsRegistry, websocketCatchUps } from '../metrics.js';
import type { EventDatabase, EventWebSocketServer } from './event-websocket.js';
import { rawData } from './websocket-data.js';

const hookA = '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hookB = '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const emptyHook = '\\xcccccccccccccccccccccccccccccccccccccccc';
const budgetHook = '\\xdddddddddddddddddddddddddddddddddddddddd';
const historyHook = '\\xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const pacedHook = '\\xffffffffffffffffffffffffffffffffffffffff';
const gasPaymaster = '\\x1111111111111111111111111111111111111111';
const msgId = `\\x${'01'.repeat(32)}`;
const msgBody = 'x'.repeat(300);
const rows = new Map([
  ['1', row(hookB)],
  ['2', row(hookA)],
]);
const gasPaymentRows = new Map<string, Record<string, unknown>>();
let notify: (channel: string, payload?: string) => void;
const explorerBatchSizes: number[] = [];
let explorerQuery = '';
let explorerQueryCount = 0;
let explorerQueryError: Error | undefined;
let explorerQueryGate: Promise<void> | undefined;
let notificationQueryError: Error | undefined;
let omitMappedGasPaymentRows = false;
const notifiedIds = new Set<string>();

const db: EventDatabase = {
  async listen(_channels, handler) {
    notify = handler;
    return async () => undefined;
  },
  async queryLive<T>(sql, values = []) {
    if (sql.includes('"gas_payment_stream_head"')) {
      const durable = [...gasPaymentRows.entries()].filter(
        ([, payment]) =>
          payment.domain === values[0] &&
          payment.interchain_gas_paymaster === values[1],
      );
      const legacyMaxId = durable.reduce((max, [id, payment]) => {
        if (payment.scraper_stream_cursor !== undefined) return max;
        return BigInt(id) > max ? BigInt(id) : max;
      }, 0n);
      const last = durable.reduce((max, [, payment]) => {
        const cursor = testStreamCursor(payment) ?? legacyMaxId;
        return cursor > max ? cursor : max;
      }, legacyMaxId);
      return queryRows<T>([
        {
          last_cursor: last.toString(),
          legacy_max_id: legacyMaxId.toString(),
        },
      ]);
    }
    if (sql.includes('MIN('))
      return queryRows<T>([
        values[1] === emptyHook
          ? { first: '0', last: '-1' }
          : values[1] === budgetHook
            ? { first: '0', last: '2' }
            : values[1] === historyHook
              ? { first: '5', last: '5' }
              : values[1] === pacedHook
                ? { first: '0', last: '1' }
                : { first: '0', last: '0' },
      ]);
    if (sql.includes('"message_view"')) {
      explorerQuery = sql;
      explorerQueryCount++;
      await explorerQueryGate;
      if (explorerQueryError) throw explorerQueryError;
      const messageIds = stringArray(values[0]);
      explorerBatchSizes.push(messageIds.length);
      return queryRows<T>(
        messageIds.map((messageId) => ({
          id: '42',
          is_delivered: false,
          msg_body: msgBody,
          msg_id: messageId,
          origin_domain_id: 1,
        })),
      );
    }
    if (sql.includes('ORDER BY "leaf_index"')) {
      if (values[1] === budgetHook)
        return queryRows<T>([
          row(budgetHook, 0),
          row(budgetHook, 1),
          row(budgetHook, 2),
        ]);
      if (values[1] === historyHook) return queryRows<T>([row(historyHook, 5)]);
      if (values[1] === pacedHook)
        return queryRows<T>([row(pacedHook, 0), row(pacedHook, 1)]);
      return queryRows<T>([row(hookA, 0)]);
    }
    if (
      !sql.includes('notification_id') &&
      sql.includes('ORDER BY "event_row"."id"') &&
      sql.includes('"gas_payment"')
    ) {
      const after = BigInt(String(values[2]));
      const through = BigInt(String(values[3]));
      return queryRows<T>(
        [...gasPaymentRows.entries()]
          .filter(
            ([id, payment]) =>
              payment.domain === values[0] &&
              payment.interchain_gas_paymaster === values[1] &&
              payment.scraper_stream_cursor === undefined &&
              BigInt(id) > after &&
              BigInt(id) <= through,
          )
          .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
          .slice(0, Number(values[4]))
          .map(([id, payment]) => ({
            ...payment,
            scraper_stream_cursor: id,
          })),
      );
    }
    if (
      !sql.includes('notification_id') &&
      sql.includes('FROM "gas_payment_stream_cursor"')
    ) {
      if (omitMappedGasPaymentRows) return [];
      const after = BigInt(String(values[2]));
      const through = BigInt(String(values[3]));
      return queryRows<T>(
        [...gasPaymentRows.values()]
          .filter(
            (payment) =>
              payment.domain === values[0] &&
              payment.interchain_gas_paymaster === values[1] &&
              testStreamCursor(payment) !== undefined &&
              (testStreamCursor(payment) ?? 0n) > after &&
              (testStreamCursor(payment) ?? 0n) <= through,
          )
          .sort((left, right) =>
            (testStreamCursor(left) ?? 0n) < (testStreamCursor(right) ?? 0n)
              ? -1
              : 1,
          )
          .slice(0, Number(values[4])),
      );
    }
    if (!sql.includes('notification_id')) return [];
    if (notificationQueryError) throw notificationQueryError;
    const ids = stringArray(values[0]);
    ids.forEach((id) => notifiedIds.add(id));
    return queryRows<T>(
      ids.flatMap((id) => {
        const event = sql.includes('"gas_payment"')
          ? gasPaymentRows.get(id)
          : rows.get(id);
        return event
          ? [
              {
                notification_id: id,
                ...event,
                scraper_stream_cursor: event.scraper_stream_cursor ?? id,
              },
            ]
          : [];
      }),
    );
  },
};

const http = createServer();
let events: EventWebSocketServer;
let url: string;
let messagesUrl: string;

before(async () => {
  process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';
  const { EventWebSocketServer } = await import('./event-websocket.js');
  events = new EventWebSocketServer(db, {
    maxAgentClients: 2,
    maxCatchUpRows: 2,
    maxConcurrentCatchUps: 1,
    maxExplorerClients: 8,
    maxTotalBufferedBytes: 1_024,
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  url = `ws://127.0.0.1:${address.port}/agents`;
  messagesUrl = `ws://127.0.0.1:${address.port}/messages`;
  await events.start(http);
});

after(async () => {
  await events.stop();
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

void it('keeps agent capacity independent from Explorer capacity', async () => {
  const explorers = Array.from({ length: 8 }, (_, index) =>
    explorerSocket(`203.0.113.${index + 10}`),
  );
  const agent = new WebSocket(url);
  const explorerMessages: Record<string, unknown>[][] = explorers.map(() => []);
  const agentMessages: Record<string, unknown>[] = [];
  explorers.forEach((socket, index) =>
    socket.on('message', (data) =>
      explorerMessages[index]?.push(parseRecord(rawData(data))),
    ),
  );
  agent.on('message', (data) => agentMessages.push(parseRecord(rawData(data))));
  await Promise.all(explorerMessages.map((items) => waitFor(items, 'ready')));
  const ready = await waitFor(agentMessages, 'ready');
  assert.equal(ready.type, 'ready');
  assert.deepEqual(ready.streamCursorVersions, { gas_payment: 2 });
  assert.deepEqual(events.metricsSnapshot().connections, {
    agent: 1,
    messages: 8,
  });
  assert.equal(events.metricsSnapshot().messageClientIps, 8);
  assert.equal(events.metricsSnapshot().limits.agentConnections, 2);
  assert.equal(events.metricsSnapshot().limits.messageConnections, 8);
  explorers.forEach((socket) => socket.close());
  agent.close();
  await waitUntil(() =>
    [...explorers, agent].every(
      ({ readyState }) => readyState === WebSocket.CLOSED,
    ),
  );
});

void it('requires the Cloudflare client IP in production', async () => {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const socket = new WebSocket(messagesUrl);
    const [code, reason] = await new Promise<[number, string]>((resolve) =>
      socket.once('close', (code, reason) =>
        resolve([code, reason.toString()]),
      ),
    );
    assert.equal(code, 1008);
    assert.match(reason, /Missing or invalid client IP/);
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
});

void it('limits Explorer connections to five per IP and releases capacity', async () => {
  const ip = '203.0.113.1';
  const sockets = Array.from({ length: 5 }, () => explorerSocket(ip));
  const messages: Record<string, unknown>[][] = sockets.map(() => []);
  sockets.forEach((socket, index) =>
    socket.on('message', (data) =>
      messages[index]?.push(parseRecord(rawData(data))),
    ),
  );
  await Promise.all(messages.map((items) => waitFor(items, 'ready')));

  const rejected = explorerSocket(ip);
  const [code, reason] = await new Promise<[number, string]>((resolve) =>
    rejected.once('close', (code, reason) =>
      resolve([code, reason.toString()]),
    ),
  );
  assert.equal(code, 1008);
  assert.match(reason, /Maximum connections per client reached/);

  const closed = new Promise<void>((resolve) =>
    sockets[0]?.once('close', () => resolve()),
  );
  sockets[0]?.close();
  await closed;

  const replacement = explorerSocket(ip);
  const replacementMessages: Record<string, unknown>[] = [];
  replacement.on('message', (data) =>
    replacementMessages.push(parseRecord(rawData(data))),
  );
  await waitFor(replacementMessages, 'ready');

  const otherIp = explorerSocket('203.0.113.2');
  const otherIpMessages: Record<string, unknown>[] = [];
  otherIp.on('message', (data) =>
    otherIpMessages.push(parseRecord(rawData(data))),
  );
  await waitFor(otherIpMessages, 'ready');

  [...sockets.slice(1), replacement, otherIp].forEach((socket) =>
    socket.close(),
  );
  await waitUntil(() =>
    [...sockets.slice(1), replacement, otherIp].every(
      ({ readyState }) => readyState === WebSocket.CLOSED,
    ),
  );
});

void it('enforces the historical replay row budget', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                { address: budgetHook, afterSequence: '-1', domain: 1 },
              ],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const message = await waitFor(messages, 'error');
  assert.equal(message.error, 'Failed to catch up merkle_tree_insertion');
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('treats a missing sequence zero as a gap for -1 cursors', async () => {
  const socket = new WebSocket(url);
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                { address: historyHook, afterSequence: '-1', domain: 1 },
              ],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const reason = await new Promise<string>((resolve) =>
    socket.once('close', (_code, reason) => resolve(reason.toString())),
  );
  assert.match(reason, /sequence gap: expected 0, received 5/);
});

void it('paces historical sends by send completion', async (context) => {
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: pacedHook, afterSequence: '-1', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitUntil(() => eventSequences(messages).includes('0'));
  await waitUntil(() => completions.length === 1);
  assert.deepEqual(eventSequences(messages), ['0']);
  assert.equal(
    messages.some(({ type }) => type === 'caught_up'),
    false,
  );
  completions.shift()?.();

  await waitUntil(() => eventSequences(messages).includes('1'));
  await waitUntil(() => completions.length === 1);
  assert.deepEqual(eventSequences(messages), ['0', '1']);
  assert.equal(
    messages.some(({ type }) => type === 'caught_up'),
    false,
  );
  completions.shift()?.();

  await waitFor(messages, 'caught_up');
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  assert.deepEqual(eventSequences(messages), ['0', '1']);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('queues catch-ups at the concurrency limit', async (context) => {
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  const completions = delayServerSendCompletions(context);
  const sockets = [new WebSocket(url), new WebSocket(url)];
  const messages: Record<string, unknown>[][] = [[], []];
  sockets.forEach((socket, index) =>
    socket.on('message', (data) => {
      const message = parseRecord(rawData(data));
      messages[index]?.push(message);
      if (message.type === 'ready') {
        socket.send(
          JSON.stringify({
            streams: [
              {
                cursors: [{ address: hookA, afterSequence: '-1', domain: 1 }],
                eventType: 'merkle_tree_insertion',
              },
            ],
            type: 'subscribe',
          }),
        );
      }
    }),
  );

  await waitUntil(
    () => messages.flat().filter(({ type }) => type === 'event').length === 1,
  );
  assert.equal(events.metricsSnapshot().catchUps, 1);
  for (let sent = 1; sent <= 4; sent++) {
    await waitUntil(() => completions.length === 1);
    if (sent === 2) now = 1_800_001;
    completions.shift()?.();
    if (sent === 2)
      await waitUntil(
        () =>
          messages.flat().filter(({ type }) => type === 'event').length === 2,
      );
  }
  await Promise.all(messages.map((items) => waitFor(items, 'caught_up')));
  sockets.forEach((socket) => socket.close());
  await waitUntil(() =>
    sockets.every(({ readyState }) => readyState === WebSocket.CLOSED),
  );
});

void it('records a disconnected historical replay as aborted', async (context) => {
  const abortedBefore = await catchUpOutcome('aborted');
  const successesBefore = await catchUpOutcome('success');
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: pacedHook, afterSequence: '-1', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitUntil(() => eventSequences(messages).includes('0'));
  await waitUntil(() => completions.length === 1);
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  socket.close();
  await closed;
  await waitUntil(() => events.metricsSnapshot().connections.agent === 0);
  completions.shift()?.();

  await waitUntil(
    async () => (await catchUpOutcome('aborted')) === abortedBefore + 1,
  );
  assert.equal(await catchUpOutcome('success'), successesBefore);
});

void it('drains live events arriving while the pending buffer is sent', async (context) => {
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: pacedHook, afterSequence: '-1', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitUntil(() => eventSequences(messages).includes('0'));
  await waitUntil(() => completions.length === 1);
  rows.set('3', row(pacedHook, 2));
  notify('scraper_event', notification('3'));
  await waitUntil(() => notifiedIds.has('3'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  completions.shift()?.();
  await waitUntil(() => eventSequences(messages).includes('1'));
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  await waitFor(messages, 'caught_up');
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();

  await waitUntil(() => eventSequences(messages).includes('2'));
  await waitUntil(() => completions.length === 1);
  rows.set('4', row(pacedHook, 3));
  notify('scraper_event', notification('4'));
  await waitUntil(() => notifiedIds.has('4'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  completions.shift()?.();

  await waitUntil(() => eventSequences(messages).includes('3'));
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  assert.deepEqual(eventSequences(messages), ['0', '1', '2', '3']);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('accepts a legacy non-cursored live gas payment subscription', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [{ domains: [1], eventType: 'gas_payment' }],
          type: 'subscribe',
        }),
      );
    }
  });

  const subscribed = await waitFor(messages, 'subscribed');
  assert.deepEqual(subscribed.streams, [
    { domains: [1], eventType: 'gas_payment' },
  ]);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('bounds gas payment stream cursor replay', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '100'));
  gasPaymentRows.set('20', gasPaymentRow('20', '200'));
  gasPaymentRows.set('30', gasPaymentRow('30', '300'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '0',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  const error = await waitFor(messages, 'error');
  assert.equal(error.error, 'Failed to catch up gas_payment');
  assert.deepEqual(eventStreamCursors(messages), []);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
  gasPaymentRows.clear();
});

void it('streams legacy and mapped gas payments without transaction metadata', async (context) => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '100'));
  gasPaymentRows.set('14', gasPaymentRow('14', null));
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '0',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitUntil(() => eventStreamCursors(messages).includes('10'));
  await waitUntil(() => completions.length === 1);
  notify('scraper_event', gasPaymentNotification('14'));
  gasPaymentRows.set('30', gasPaymentRow('30', null, '15'));
  notify('scraper_event', gasPaymentNotification('30'));
  await waitUntil(() => notifiedIds.has('14') && notifiedIds.has('30'));
  completions.shift()?.();
  await waitUntil(() => eventStreamCursors(messages).includes('14'));
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  const caughtUp = await waitFor(messages, 'caught_up');
  assert.equal(caughtUp.streamCursor, '14');
  assert.equal(caughtUp.legacyMaxStreamCursor, '14');
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  await waitUntil(() => eventStreamCursors(messages).includes('15'));
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  assert.deepEqual(eventStreamCursors(messages), ['10', '14', '15']);
  assert.deepEqual(
    messages
      .filter(({ type }) => type === 'event')
      .map(({ data }) => record(data).tx_id),
    ['100', null, null],
  );
  assert.deepEqual(
    messages
      .filter(
        ({ eventType, type }) =>
          type === 'event' && eventType === 'gas_payment',
      )
      .map(({ legacyMaxStreamCursor }) => legacyMaxStreamCursor),
    ['14', '14', '14'],
  );

  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));

  const resumed = new WebSocket(url);
  const resumedMessages: Record<string, unknown>[] = [];
  resumed.on('message', (data) => {
    const message = parseRecord(rawData(data));
    resumedMessages.push(message);
    if (message.type === 'ready') {
      resumed.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '15',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const resumedMarker = await waitFor(resumedMessages, 'caught_up');
  assert.equal(resumedMarker.streamCursor, '15');
  assert.equal(resumedMarker.legacyMaxStreamCursor, '14');
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();

  notify('scraper_event', gasPaymentNotification('30'));
  notify('scraper_event', gasPaymentNotification('35'));
  await waitUntil(() => notifiedIds.has('35'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(eventStreamCursors(resumedMessages), []);

  gasPaymentRows.set('42', gasPaymentRow('42', '420', '16'));
  notify('scraper_event', gasPaymentNotification('42'));
  await waitUntil(() => eventStreamCursors(resumedMessages).includes('16'));
  assert.deepEqual(eventStreamCursors(resumedMessages), ['16']);
  await waitUntil(() => completions.length === 1);
  completions.shift()?.();
  resumed.close();
  await new Promise<void>((resolve) => resumed.once('close', resolve));
  gasPaymentRows.clear();
});

void it('orders gas payments by commit cursor instead of allocated row ID', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('100', gasPaymentRow('100', '1000', '2'));
  gasPaymentRows.set('101', gasPaymentRow('101', '1001', '1'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '0',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitFor(messages, 'caught_up');
  assert.deepEqual(eventStreamCursors(messages), ['1', '2']);
  assert.deepEqual(
    messages
      .filter(({ type }) => type === 'event')
      .map(({ data }) => record(data).id),
    ['101', '100'],
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
  gasPaymentRows.clear();
});

void it('rejects a gap at the legacy-to-mapped cursor transition', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '100'));
  gasPaymentRows.set('100', gasPaymentRow('100', '1000', '12'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '10',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  const [code, reason] = await new Promise<[number, string]>((resolve) =>
    socket.once('close', (code, reason) => resolve([code, reason.toString()])),
  );
  assert.equal(code, 1013);
  assert.equal(
    reason,
    'gas_payment stream cursor gap: expected 11, received 12',
  );
  assert.deepEqual(eventStreamCursors(messages), []);
  assert.equal(
    messages.some(({ type }) => type === 'caught_up'),
    false,
  );
  gasPaymentRows.clear();
});

void it('rejects an empty mapped gas payment cursor range', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '100'));
  gasPaymentRows.set('100', gasPaymentRow('100', '1000', '11'));
  omitMappedGasPaymentRows = true;
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '10',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  try {
    const error = await waitFor(messages, 'error');
    assert.equal(error.error, 'Failed to catch up gas_payment');
    assert.deepEqual(eventStreamCursors(messages), []);
    assert.equal(
      messages.some(({ type }) => type === 'caught_up'),
      false,
    );
  } finally {
    omitMappedGasPaymentRows = false;
    gasPaymentRows.clear();
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', resolve));
  }
});

void it('disconnects a live gas payment cursor gap', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '100'));
  gasPaymentRows.set('100', gasPaymentRow('100', '1000', '11'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '11',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  await waitFor(messages, 'caught_up');
  gasPaymentRows.set('102', gasPaymentRow('102', '1002', '13'));
  notify('scraper_event', gasPaymentNotification('102'));
  const [code, reason] = await new Promise<[number, string]>((resolve) =>
    socket.once('close', (code, reason) => resolve([code, reason.toString()])),
  );
  assert.equal(code, 1013);
  assert.equal(
    reason,
    'gas_payment stream cursor gap: expected 12, received 13',
  );
  assert.deepEqual(eventStreamCursors(messages), []);
  gasPaymentRows.clear();
});

void it('crosses the immutable legacy boundary before mapped replay', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('10', gasPaymentRow('10', '1000'));
  gasPaymentRows.set('9', gasPaymentRow('9', '1001', '11'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '0',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  const caughtUp = await waitFor(messages, 'caught_up');
  assert.equal(caughtUp.streamCursor, '11');
  assert.deepEqual(eventStreamCursors(messages), ['10', '11']);
  assert.deepEqual(
    messages
      .filter(({ type }) => type === 'event')
      .map(({ data }) => record(data).id),
    ['10', '9'],
  );
  assert.deepEqual(
    messages.filter(({ type }) => type === 'event').map(({ rowId }) => rowId),
    ['10', '9'],
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
  gasPaymentRows.clear();
});

void it('rejects a gas payment cursor ahead of the durable high-water', async () => {
  gasPaymentRows.clear();
  gasPaymentRows.set('20', gasPaymentRow('20', '200'));
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: gasPaymaster,
                  afterStreamCursor: '30',
                  domain: 1,
                },
              ],
              eventType: 'gas_payment',
              streamCursorVersion: 2,
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  const error = await waitFor(messages, 'error');
  assert.equal(error.error, 'Failed to catch up gas_payment');
  assert.equal(
    messages.some(({ type }) => type === 'caught_up'),
    false,
  );

  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
  gasPaymentRows.clear();
});

void it('enforces the catch-up deadline while pending rows replenish', async (context) => {
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  const completions = delayServerSendCompletions(context);
  let deadlineNotify: (channel: string, payload?: string) => void;
  const deadlineDb: EventDatabase = {
    ...db,
    async listen(_channels, handler) {
      deadlineNotify = handler;
      return async () => undefined;
    },
  };
  const deadlineHttp = createServer();
  const { EventWebSocketServer } = await import('./event-websocket.js');
  const deadlineEvents = new EventWebSocketServer(deadlineDb, {
    maxCatchUpMs: 10,
    maxCatchUpRows: 10,
  });
  await new Promise<void>((resolve) =>
    deadlineHttp.listen(0, '127.0.0.1', resolve),
  );
  const address = deadlineHttp.address();
  assert(address && typeof address !== 'string');
  await deadlineEvents.start(deadlineHttp);

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agents`);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: pacedHook, afterSequence: '-1', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });

  try {
    await waitUntil(() => eventSequences(messages).includes('0'));
    await waitUntil(() => completions.length === 1);
    rows.set('5', row(pacedHook, 2));
    deadlineNotify('scraper_event', notification('5'));
    await waitUntil(() => notifiedIds.has('5'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    completions.shift()?.();
    await waitUntil(() => eventSequences(messages).includes('1'));
    await waitUntil(() => completions.length === 1);
    completions.shift()?.();
    await waitFor(messages, 'caught_up');
    await waitUntil(() => completions.length === 1);
    completions.shift()?.();

    await waitUntil(() => eventSequences(messages).includes('2'));
    await waitUntil(() => completions.length === 1);
    rows.set('6', row(pacedHook, 3));
    deadlineNotify('scraper_event', notification('6'));
    await waitUntil(() => notifiedIds.has('6'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 11;
    completions.shift()?.();

    const error = await waitFor(messages, 'error');
    assert.equal(error.error, 'Failed to catch up merkle_tree_insertion');
    assert.deepEqual(eventSequences(messages), ['0', '1', '2']);
  } finally {
    socket.close();
    await new Promise<void>((resolve) => socket.once('close', resolve));
    await deadlineEvents.stop();
    await new Promise<void>((resolve, reject) =>
      deadlineHttp.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

void it('reports a fresh empty historical cursor at -1', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: emptyHook, domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const message = await waitFor(messages, 'caught_up');
  assert.equal(message.address, '0xcccccccccccccccccccccccccccccccccccccccc');
  assert.equal(message.sequence, '-1');
  assert.equal(
    messages.some(({ type }) => type === 'error'),
    false,
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('rejects a durable cursor when its history is empty', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: emptyHook, afterSequence: '0', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const message = await waitFor(messages, 'error');
  assert.equal(message.error, 'Failed to catch up merkle_tree_insertion');
  assert.equal(
    messages.some(({ type }) => type === 'caught_up'),
    false,
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('catches up populated and fresh empty origins together', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                { address: hookA, afterSequence: '-1', domain: 1 },
                { address: emptyHook, domain: 2 },
              ],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  await waitUntil(
    () => messages.filter(({ type }) => type === 'caught_up').length === 2,
  );
  assert.deepEqual(
    messages
      .filter(({ type }) => type === 'caught_up')
      .map(({ domain, sequence }) => [domain, sequence]),
    [
      [1, '0'],
      [2, '-1'],
    ],
  );
  assert.equal(
    messages.some(({ type }) => type === 'error'),
    false,
  );
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('requires replay opt-in for a cursor ahead of scraper history', async () => {
  const rejected = new WebSocket(url);
  const rejectedMessages: Record<string, unknown>[] = [];
  rejected.on('message', (data) => {
    const message = parseRecord(rawData(data));
    rejectedMessages.push(message);
    if (message.type === 'ready') {
      rejected.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: hookA, afterSequence: '10', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const error = await waitFor(rejectedMessages, 'error');
  assert.equal(error.error, 'Failed to catch up merkle_tree_insertion');
  rejected.close();
  await new Promise<void>((resolve) => rejected.once('close', resolve));

  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [
                {
                  address: hookA,
                  afterSequence: '10',
                  allowReplay: true,
                  domain: 1,
                },
              ],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  const caughtUp = await waitFor(messages, 'caught_up');
  assert.equal(caughtUp.sequence, '0');
  assert.deepEqual(eventSequences(messages), []);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', resolve));
});

void it('only emits addresses named by sequence cursors', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [
            {
              cursors: [{ address: hookA, afterSequence: '0', domain: 1 }],
              eventType: 'merkle_tree_insertion',
            },
          ],
          type: 'subscribe',
        }),
      );
    }
  });
  await waitFor(messages, 'caught_up');
  notify('scraper_event', notification('1'));
  notify('scraper_event', notification('2'));
  const event = await waitFor(messages, 'event');
  assert.equal(record(event.data).merkle_tree_hook, hookA);
  assert.equal(messages.filter(({ type }) => type === 'event').length, 1);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
});

void it('emits normalized message upserts to Explorer', async () => {
  const socket = new WebSocket(messagesUrl);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  await waitFor(messages, 'ready');
  notify(
    'scraper_explorer_event',
    JSON.stringify({ messageId: msgId.slice(2) }),
  );
  const event = await waitFor(messages, 'message_upsert');
  assert.match(explorerQuery, /"send_occurred_at" IS NOT NULL/);
  assert.deepEqual(event.data, {
    id: '42',
    is_delivered: false,
    msg_body: msgBody,
    msg_id: msgId,
    origin_domain_id: 1,
  });
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
});

void it('keeps agent delivery independent from a blocked Explorer query', async () => {
  let releaseExplorerQuery: (() => void) | undefined;
  explorerQueryGate = new Promise<void>((resolve) => {
    releaseExplorerQuery = resolve;
  });
  const explorer = new WebSocket(messagesUrl);
  const agent = new WebSocket(url);
  const explorerMessages: Record<string, unknown>[] = [];
  const agentMessages: Record<string, unknown>[] = [];
  explorer.on('message', (data) =>
    explorerMessages.push(parseRecord(rawData(data))),
  );
  agent.on('message', (data) => {
    const message = parseRecord(rawData(data));
    agentMessages.push(message);
    if (message.type === 'ready') {
      agent.send(
        JSON.stringify({
          streams: [{ eventType: 'merkle_tree_insertion' }],
          type: 'subscribe',
        }),
      );
    }
  });
  try {
    await Promise.all([
      waitFor(explorerMessages, 'ready'),
      waitFor(agentMessages, 'subscribed'),
    ]);
    const queriesBefore = explorerQueryCount;
    notify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: msgId.slice(2) }),
    );
    await waitUntil(() => explorerQueryCount > queriesBefore);

    rows.set('5', row(hookA, 5));
    notify('scraper_event', notification('5'));
    const event = await waitFor(agentMessages, 'event');
    assert.equal(record(event.data).leaf_index, 5);
    assert.equal(
      explorerMessages.some(({ type }) => type === 'message_upsert'),
      false,
    );

    releaseExplorerQuery();
    await waitFor(explorerMessages, 'message_upsert');
  } finally {
    releaseExplorerQuery?.();
    explorerQueryGate = undefined;
    explorer.close();
    agent.close();
    await waitUntil(() =>
      [explorer, agent].every(
        ({ readyState }) => readyState === WebSocket.CLOSED,
      ),
    );
  }
});

void it('keeps agents connected when an Explorer query fails', async () => {
  const explorer = new WebSocket(messagesUrl);
  const explorerMessages: Record<string, unknown>[] = [];
  const agentMessages: Record<string, unknown>[] = [];
  explorer.on('message', (data) =>
    explorerMessages.push(parseRecord(rawData(data))),
  );
  const agent = liveAgent(agentMessages);
  try {
    await Promise.all([
      waitFor(explorerMessages, 'ready'),
      waitFor(agentMessages, 'subscribed'),
    ]);
    explorerQueryError = new Error('Explorer query failed');
    notify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: msgId.slice(2) }),
    );
    await new Promise<void>((resolve) =>
      explorer.once('close', () => resolve()),
    );
    explorerQueryError = undefined;

    rows.set('6', row(hookA, 6));
    notify('scraper_event', notification('6'));
    const event = await waitFor(agentMessages, 'event');
    assert.equal(record(event.data).leaf_index, 6);
    assert.equal(agent.readyState, WebSocket.OPEN);
  } finally {
    explorerQueryError = undefined;
    explorer.close();
    agent.close();
    await waitUntil(() =>
      [explorer, agent].every(
        ({ readyState }) => readyState === WebSocket.CLOSED,
      ),
    );
  }
});

void it('keeps Explorer connected when an agent query fails', async () => {
  const explorer = new WebSocket(messagesUrl);
  const explorerMessages: Record<string, unknown>[] = [];
  const agentMessages: Record<string, unknown>[] = [];
  explorer.on('message', (data) =>
    explorerMessages.push(parseRecord(rawData(data))),
  );
  const agent = liveAgent(agentMessages);
  try {
    await Promise.all([
      waitFor(explorerMessages, 'ready'),
      waitFor(agentMessages, 'subscribed'),
    ]);
    notificationQueryError = new Error('Agent query failed');
    rows.set('7', row(hookA, 7));
    notify('scraper_event', notification('7'));
    await new Promise<void>((resolve) => agent.once('close', () => resolve()));
    notificationQueryError = undefined;

    notify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: msgId.slice(2) }),
    );
    await waitFor(explorerMessages, 'message_upsert');
    assert.equal(explorer.readyState, WebSocket.OPEN);
  } finally {
    notificationQueryError = undefined;
    agent.close();
    explorer.close();
    await waitUntil(() =>
      [agent, explorer].every(
        ({ readyState }) => readyState === WebSocket.CLOSED,
      ),
    );
  }
});

void it('bounds Explorer notifications without closing agents', async () => {
  const explorer = new WebSocket(messagesUrl);
  const explorerMessages: Record<string, unknown>[] = [];
  const agentMessages: Record<string, unknown>[] = [];
  explorer.on('message', (data) =>
    explorerMessages.push(parseRecord(rawData(data))),
  );
  const agent = liveAgent(agentMessages);
  try {
    await Promise.all([
      waitFor(explorerMessages, 'ready'),
      waitFor(agentMessages, 'subscribed'),
    ]);
    for (let index = 0; index <= 10_000; index++) {
      notify(
        'scraper_explorer_event',
        JSON.stringify({ messageId: index.toString(16).padStart(64, '0') }),
      );
    }
    await waitUntil(() => explorer.readyState === WebSocket.CLOSED);
    assert.equal(agent.readyState, WebSocket.OPEN);
    assert.equal(events.metricsSnapshot().notificationQueue.messages, 0);
    assert.match(
      await metricsRegistry.metrics(),
      /websocket_send_failures_total\{reason="notification_queue_limit"\} 1/,
    );
  } finally {
    agent.close();
    if (explorer.readyState !== WebSocket.CLOSED) explorer.close();
    await waitUntil(() =>
      [explorer, agent].every(
        ({ readyState }) => readyState === WebSocket.CLOSED,
      ),
    );
  }
});

void it('bounds agent notifications without closing Explorer', async () => {
  const explorer = new WebSocket(messagesUrl);
  const explorerMessages: Record<string, unknown>[] = [];
  const agentMessages: Record<string, unknown>[] = [];
  explorer.on('message', (data) =>
    explorerMessages.push(parseRecord(rawData(data))),
  );
  const agent = liveAgent(agentMessages);
  try {
    await Promise.all([
      waitFor(explorerMessages, 'ready'),
      waitFor(agentMessages, 'subscribed'),
    ]);
    for (let index = 0; index <= 10_000; index++)
      notify('scraper_event', notification((index + 20_000).toString()));

    await waitUntil(() => agent.readyState === WebSocket.CLOSED);
    assert.equal(explorer.readyState, WebSocket.OPEN);
    assert.equal(events.metricsSnapshot().notificationQueue.agent, 0);
    assert.match(
      await metricsRegistry.metrics(),
      /websocket_notification_queue_overflows_total\{route="agent"\} 1/,
    );
  } finally {
    explorer.close();
    if (agent.readyState !== WebSocket.CLOSED) agent.close();
    await waitUntil(() =>
      [explorer, agent].every(
        ({ readyState }) => readyState === WebSocket.CLOSED,
      ),
    );
  }
});

void it('keeps fast Explorer clients independent from a stalled client', async (context) => {
  const completions = delayFirstExplorerSocket(context);
  const sockets = [new WebSocket(messagesUrl), new WebSocket(messagesUrl)];
  const messages: Record<string, unknown>[][] = sockets.map(() => []);
  sockets.forEach((socket, index) =>
    socket.on('message', (data) =>
      messages[index]?.push(parseRecord(rawData(data))),
    ),
  );
  try {
    await Promise.all(messages.map((items) => waitFor(items, 'ready')));
    for (const byte of ['02', '03']) {
      notify(
        'scraper_explorer_event',
        JSON.stringify({ messageId: byte.repeat(32) }),
      );
      if (byte === '02') {
        await waitUntil(
          () =>
            messages.every(
              (items) =>
                items.filter(({ type }) => type === 'message_upsert').length ===
                1,
            ) && completions.length === 1,
        );
      }
    }
    await waitUntil(() =>
      messages.some(
        (items) =>
          items.filter(({ type }) => type === 'message_upsert').length === 2,
      ),
    );
    assert.deepEqual(
      messages
        .map(
          (items) =>
            items.filter(({ type }) => type === 'message_upsert').length,
        )
        .sort(),
      [1, 2],
    );

    completions.shift()?.();
    await waitUntil(() =>
      messages.every(
        (items) =>
          items.filter(({ type }) => type === 'message_upsert').length === 2,
      ),
    );
  } finally {
    for (const complete of completions.splice(0)) complete();
    sockets.forEach((socket) => socket.close());
    await waitUntil(() =>
      sockets.every(({ readyState }) => readyState === WebSocket.CLOSED),
    );
  }
});

void it('paces a full Explorer notification batch one send at a time', async (context) => {
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(messagesUrl);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  try {
    await waitFor(messages, 'ready');
    const batchesBefore = explorerBatchSizes.length;
    const messageIds = Array.from(
      { length: 1_000 },
      (_, index) => `\\x${index.toString(16).padStart(64, '0')}`,
    );
    for (const messageId of messageIds) {
      notify(
        'scraper_explorer_event',
        JSON.stringify({ messageId: messageId.slice(2) }),
      );
    }
    await waitUntil(() => completions.length === 1);
    for (let sent = 1; sent <= messageIds.length; sent++) {
      assert.equal(completions.length, 1);
      completions.shift()?.();
      if (sent < messageIds.length) {
        await waitUntilImmediate(() => completions.length === 1);
      }
    }
    await waitUntil(
      () =>
        messages.filter(({ type }) => type === 'message_upsert').length ===
          messageIds.length &&
        events.metricsSnapshot().explorerPendingMessages === 0,
    );
    const upserts = messages.filter(({ type }) => type === 'message_upsert');
    assert.deepEqual(
      new Set(upserts.map(({ data }) => record(data).msg_id)),
      new Set(messageIds),
    );
    assert.equal(events.metricsSnapshot().explorerPendingBytes, 0);
    assert.equal(events.metricsSnapshot().outboundPendingBytes, 0);
    assert.equal(socket.readyState, WebSocket.OPEN);
    const batchSizes = explorerBatchSizes.slice(batchesBefore);
    assert.equal(
      batchSizes.reduce((total, size) => total + size, 0),
      1_000,
    );
    assert(batchSizes.every((size) => size <= 100));
  } finally {
    for (const complete of completions.splice(0)) complete();
    socket.close();
    await waitUntil(() => socket.readyState === WebSocket.CLOSED);
  }
});

void it('sheds only an Explorer client that exceeds its queue limit', async (context) => {
  const slow = new WebSocket(messagesUrl);
  const slowMessages: Record<string, unknown>[] = [];
  slow.on('message', (data) => slowMessages.push(parseRecord(rawData(data))));
  await waitFor(slowMessages, 'ready');
  const fast = new WebSocket(messagesUrl);
  const fastMessages: Record<string, unknown>[] = [];
  fast.on('message', (data) => fastMessages.push(parseRecord(rawData(data))));
  await waitFor(fastMessages, 'ready');
  const completions = delayFirstExplorerSocket(context);

  try {
    for (let batch = 0; batch < 21; batch++) {
      for (let index = 0; index < 100; index++) {
        const messageId = (batch * 100 + index + 10_000)
          .toString(16)
          .padStart(64, '0');
        notify('scraper_explorer_event', JSON.stringify({ messageId }));
      }
      const expected = Math.min((batch + 1) * 100, 2_000);
      await waitUntil(
        () =>
          fastMessages.filter(({ type }) => type === 'message_upsert').length >=
          expected,
      );
    }

    await waitUntil(() => slow.readyState === WebSocket.CLOSED);
    assert.equal(fast.readyState, WebSocket.OPEN);
    assert.equal(events.metricsSnapshot().connections.messages, 1);
    assert.equal(events.metricsSnapshot().explorerPendingMessages, 0);
    assert.equal(events.metricsSnapshot().explorerPendingBytes, 0);
    assert.match(
      await metricsRegistry.metrics(),
      /websocket_send_failures_total\{reason="queue_limit"\} 1/,
    );
  } finally {
    for (const complete of completions.splice(0)) complete();
    fast.close();
    if (slow.readyState !== WebSocket.CLOSED) slow.close();
    await waitUntil(() =>
      [slow, fast].every(({ readyState }) => readyState === WebSocket.CLOSED),
    );
  }
});

void it('paces Explorer batches by send completion', async (context) => {
  const socket = new WebSocket(messagesUrl);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  await waitFor(messages, 'ready');
  const completions = delayServerSendCompletions(context);
  const messageIds = [`\\x${'02'.repeat(32)}`, `\\x${'03'.repeat(32)}`];

  try {
    for (const messageId of messageIds) {
      notify(
        'scraper_explorer_event',
        JSON.stringify({ messageId: messageId.slice(2) }),
      );
    }
    const upserts = (): Record<string, unknown>[] =>
      messages.filter(({ type }) => type === 'message_upsert');

    await waitUntil(() => upserts().length === 1 && completions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upserts().length, 1);
    assert.equal(socket.readyState, WebSocket.OPEN);

    completions.shift()?.();
    await waitUntil(() => upserts().length === 2 && completions.length === 1);
    assert.deepEqual(
      upserts().map(({ data }) => record(data).msg_id),
      messageIds,
    );
    assert.equal(socket.readyState, WebSocket.OPEN);
    completions.shift()?.();
  } finally {
    for (const complete of completions.splice(0)) complete();
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) =>
        socket.once('close', () => resolve()),
      );
      socket.close();
      await closed;
    }
  }
});

void it('releases a peer-closed Explorer queue immediately', async (context) => {
  const socket = new WebSocket(messagesUrl);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  await waitFor(messages, 'ready');
  const completions = delayServerSendCompletions(context);
  for (const byte of ['04', '05']) {
    notify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: byte.repeat(32) }),
    );
  }
  await waitUntil(
    () =>
      completions.length === 1 &&
      events.metricsSnapshot().explorerPendingMessages === 1,
  );
  socket.close();
  await waitUntil(
    () =>
      socket.readyState === WebSocket.CLOSED &&
      events.metricsSnapshot().connections.messages === 0,
  );
  assert.equal(events.metricsSnapshot().explorerPendingMessages, 0);
  assert.equal(events.metricsSnapshot().explorerPendingBytes, 0);
  for (const complete of completions.splice(0)) complete();
});

void it('bounds aggregate Explorer outbound buffering', async () => {
  const sockets = Array.from({ length: 4 }, () => new WebSocket(messagesUrl));
  const messages: Record<string, unknown>[][] = sockets.map(() => []);
  const closeCodes: number[] = [];
  sockets.forEach((socket, index) => {
    socket.on('message', (data) =>
      messages[index]?.push(parseRecord(rawData(data))),
    );
    socket.on('close', (code) => closeCodes.push(code));
  });
  await Promise.all(messages.map((items) => waitFor(items, 'ready')));
  notify(
    'scraper_explorer_event',
    JSON.stringify({ messageId: msgId.slice(2) }),
  );
  await waitUntil(
    () =>
      messages.flat().some(({ type }) => type === 'message_upsert') &&
      closeCodes.includes(1006),
  );
  assert(closeCodes.includes(1006));
  sockets.forEach((socket) => socket.close());
  await waitUntil(() =>
    sockets.every(({ readyState }) => readyState === WebSocket.CLOSED),
  );
});

function row(
  merkle_tree_hook: string,
  leaf_index = 1,
): Record<string, unknown> {
  return {
    block_number: '1',
    domain: 1,
    leaf_index,
    merkle_tree_hook,
    message_id: msgId,
  };
}

function gasPaymentRow(
  id: string,
  txId: string | null,
  streamCursor?: string,
): Record<string, unknown> {
  return {
    destination: 2,
    domain: 1,
    gas_amount: '50000',
    id,
    interchain_gas_paymaster: gasPaymaster,
    log_index: '0',
    msg_id: msgId,
    origin: 1,
    origin_block_hash: `\\x${'02'.repeat(32)}`,
    origin_block_height: '100',
    origin_tx_hash: `\\x${'03'.repeat(32)}`,
    payment: '1000',
    sequence: null,
    ...(streamCursor === undefined
      ? {}
      : { scraper_stream_cursor: streamCursor }),
    time_created: new Date(0).toISOString(),
    tx_id: txId,
  };
}

function testStreamCursor(
  payment: Record<string, unknown>,
): bigint | undefined {
  return typeof payment.scraper_stream_cursor === 'string'
    ? BigInt(payment.scraper_stream_cursor)
    : undefined;
}

function gasPaymentNotification(id: string): string {
  return JSON.stringify({ domain: 1, eventType: 'gas_payment', id });
}

function explorerSocket(ip: string): WebSocket {
  return new WebSocket(messagesUrl, {
    headers: { 'cf-connecting-ip': ip },
  });
}

function liveAgent(messages: Record<string, unknown>[]): WebSocket {
  const socket = new WebSocket(url);
  socket.on('message', (data) => {
    const message = parseRecord(rawData(data));
    messages.push(message);
    if (message.type === 'ready') {
      socket.send(
        JSON.stringify({
          streams: [{ eventType: 'merkle_tree_insertion' }],
          type: 'subscribe',
        }),
      );
    }
  });
  return socket;
}

function delayServerSendCompletions(context: TestContext): Array<() => void> {
  const completions: Array<() => void> = [];
  // oxlint-disable-next-line typescript/unbound-method -- called with the socket receiver below.
  const originalSend = WebSocket.prototype.send;
  context.mock.method(
    WebSocket.prototype,
    'send',
    function (
      this: WebSocket,
      data: Parameters<WebSocket['send']>[0],
      optionsOrCallback?:
        | Parameters<WebSocket['send']>[1]
        | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ): void {
      const completion =
        typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const message = typeof data === 'string' ? parseRecord(data) : undefined;
      const delay =
        completion &&
        (message?.type === 'event' ||
          message?.type === 'caught_up' ||
          message?.type === 'message_upsert');
      const completed = delay
        ? (error?: Error) => completions.push(() => completion(error))
        : completion;
      if (typeof optionsOrCallback === 'function' || !optionsOrCallback) {
        originalSend.call(this, data, completed);
      } else {
        originalSend.call(this, data, optionsOrCallback, completed);
      }
    },
  );
  return completions;
}

function delayFirstExplorerSocket(context: TestContext): Array<() => void> {
  const completions: Array<() => void> = [];
  const delayedSockets = new WeakSet<WebSocket>();
  let selectedDelayedSocket = false;
  // oxlint-disable-next-line typescript/unbound-method -- called with the socket receiver below.
  const originalSend = WebSocket.prototype.send;
  context.mock.method(
    WebSocket.prototype,
    'send',
    function (
      this: WebSocket,
      data: Parameters<WebSocket['send']>[0],
      optionsOrCallback?:
        | Parameters<WebSocket['send']>[1]
        | ((error?: Error) => void),
      callback?: (error?: Error) => void,
    ): void {
      const completion =
        typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      const message = typeof data === 'string' ? parseRecord(data) : undefined;
      if (
        !selectedDelayedSocket &&
        completion &&
        message?.type === 'message_upsert'
      ) {
        delayedSockets.add(this);
        selectedDelayedSocket = true;
      }
      const delayedCompletion =
        completion &&
        message?.type === 'message_upsert' &&
        delayedSockets.has(this)
          ? (error?: Error) => completions.push(() => completion(error))
          : completion;
      if (typeof optionsOrCallback === 'function' || !optionsOrCallback) {
        originalSend.call(this, data, delayedCompletion);
      } else {
        originalSend.call(this, data, optionsOrCallback, delayedCompletion);
      }
    },
  );
  return completions;
}

function eventSequences(messages: Record<string, unknown>[]): unknown[] {
  return messages
    .filter(({ type }) => type === 'event')
    .map(({ sequence }) => sequence);
}

function eventStreamCursors(messages: Record<string, unknown>[]): unknown[] {
  return messages
    .filter(({ type }) => type === 'event')
    .map(({ streamCursor }) => streamCursor);
}

function notification(id: string): string {
  return JSON.stringify({
    domain: 1,
    eventType: 'merkle_tree_insertion',
    id,
  });
}

async function waitFor(
  messages: Record<string, unknown>[],
  type: string,
): Promise<Record<string, unknown>> {
  for (let attempts = 0; attempts < 100; attempts++) {
    const message = messages.find((item) => item.type === type);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function waitUntilImmediate(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempts = 0; attempts < 10_000; attempts++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for immediate condition');
}

async function catchUpOutcome(outcome: string): Promise<number> {
  const metric = await websocketCatchUps.get();
  return (
    metric.values.find(({ labels }) => labels.outcome === outcome)?.value ?? 0
  );
}

function parseRecord(value: string): Record<string, unknown> {
  return record(JSON.parse(value));
}

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function stringArray(value: unknown): string[] {
  assert(
    Array.isArray(value) && value.every((item) => typeof item === 'string'),
  );
  return value;
}

function queryRows<T extends QueryResultRow>(rows: QueryResultRow[]): T[] {
  // CAST: This SQL-aware fake returns the row shape requested by each known query.
  return rows as T[];
}
