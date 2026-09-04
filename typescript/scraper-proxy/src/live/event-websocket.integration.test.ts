import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, it, type TestContext } from 'node:test';

import { WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';

import {
  metricsRegistry,
  websocketCatchUps,
  websocketSendFailures,
} from '../metrics.js';
import type { EventDatabase, EventWebSocketServer } from './event-websocket.js';
import { rawData } from './websocket-data.js';

const hookA = '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hookB = '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const emptyHook = '\\xcccccccccccccccccccccccccccccccccccccccc';
const budgetHook = '\\xdddddddddddddddddddddddddddddddddddddddd';
const historyHook = '\\xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const pacedHook = '\\xffffffffffffffffffffffffffffffffffffffff';
const msgId = `\\x${'01'.repeat(32)}`;
const msgBody = 'x'.repeat(300);
const rows = new Map([
  ['1', row(hookB)],
  ['2', row(hookA)],
]);
let notify: (channel: string, payload?: string) => void;
const explorerBatchSizes: number[] = [];
let explorerQuery = '';
let explorerQueryCount = 0;
let explorerQueryError: Error | undefined;
let explorerQueryGate: Promise<void> | undefined;
let notificationQueryError: Error | undefined;
const notifiedIds = new Set<string>();

const db: EventDatabase = {
  async listen(_channels, handler) {
    notify = handler;
    return async () => undefined;
  },
  async queryLive<T>(sql, values = []) {
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
    if (!sql.includes('notification_id')) return [];
    if (notificationQueryError) throw notificationQueryError;
    const ids = stringArray(values[0]);
    ids.forEach((id) => notifiedIds.add(id));
    return queryRows<T>(
      ids.map((id) => ({
        notification_id: id,
        ...rows.get(id),
      })),
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
    maxAgentClients: 1,
    maxCatchUpRows: 2,
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
  assert.deepEqual(events.metricsSnapshot().connections, {
    agent: 1,
    messages: 8,
  });
  assert.equal(events.metricsSnapshot().messageClientIps, 8);
  assert.equal(events.metricsSnapshot().limits.agentConnections, 1);
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

void it('rejects an empty historical cursor instead of reporting caught up', async () => {
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
              cursors: [{ address: emptyHook, afterSequence: '-1', domain: 1 }],
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

void it('reports an active send failure once', async (context) => {
  const socket = new WebSocket(messagesUrl);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  await waitFor(messages, 'ready');
  const completions = delayServerSendCompletions(context);
  const failuresBefore = await sendFailureCount();

  try {
    notify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: msgId.slice(2) }),
    );
    await waitUntil(() => completions.length === 1);
    completions.shift()?.(new Error('write failed'));
    await waitUntil(() => socket.readyState === WebSocket.CLOSED);

    assert.equal(await sendFailureCount(), failuresBefore + 1);
  } finally {
    for (const complete of completions.splice(0)) complete();
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
});

void it('does not report heartbeat cleanup as a send failure', async (context) => {
  let heartbeatNotify: (channel: string, payload?: string) => void;
  const heartbeatDb: EventDatabase = {
    listen: async (_channels, handler) => {
      heartbeatNotify = handler;
      return async () => undefined;
    },
    queryLive: db.queryLive,
  };
  const heartbeatHttp = createServer();
  const { EventWebSocketServer } = await import('./event-websocket.js');
  const heartbeatEvents = new EventWebSocketServer(heartbeatDb, {
    heartbeatMs: 250,
    maxExplorerClients: 1,
  });
  await new Promise<void>((resolve) =>
    heartbeatHttp.listen(0, '127.0.0.1', resolve),
  );
  const address = heartbeatHttp.address();
  assert(address && typeof address !== 'string');
  await heartbeatEvents.start(heartbeatHttp);
  const completions = delayServerSendCompletions(context);
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/messages`, {
    autoPong: false,
  });
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => messages.push(parseRecord(rawData(data))));
  const failuresBefore = await sendFailureCount();

  try {
    await waitFor(messages, 'ready');
    heartbeatNotify(
      'scraper_explorer_event',
      JSON.stringify({ messageId: msgId.slice(2) }),
    );
    await waitUntil(() => completions.length === 1);
    await waitUntil(() => socket.readyState === WebSocket.CLOSED);
    completions.shift()?.(new Error('write ECANCELED'));
    await waitUntil(
      () => heartbeatEvents.metricsSnapshot().outboundPendingBytes === 0,
    );

    assert.equal(await sendFailureCount(), failuresBefore);
    assert.equal(heartbeatEvents.metricsSnapshot().connections.messages, 0);
  } finally {
    for (const complete of completions.splice(0)) complete();
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await heartbeatEvents.stop();
    await new Promise<void>((resolve, reject) =>
      heartbeatHttp.close((error) => (error ? reject(error) : resolve())),
    );
  }
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

function delayServerSendCompletions(
  context: TestContext,
): Array<(error?: Error) => void> {
  const completions: Array<(error?: Error) => void> = [];
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
        ? (error?: Error) =>
            completions.push((override = error) => completion(override))
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

async function sendFailureCount(): Promise<number> {
  const metric = await websocketSendFailures.get();
  return (
    metric.values.find(({ labels }) => labels.reason === 'send_error')?.value ??
    0
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
