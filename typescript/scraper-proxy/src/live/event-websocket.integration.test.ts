import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, it, type TestContext } from 'node:test';

import { WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';

import { websocketCatchUps } from '../metrics.js';
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
let explorerQuery = '';
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
      return queryRows<T>(
        stringArray(values[0]).map((messageId) => ({
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
    maxTotalBufferedBytes: 512,
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
  assert.match(String(message.error), /row limit exceeded/);
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
    assert.match(String(error.error), /time limit exceeded \(10ms\)/);
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
  assert.match(String(message.error), /No merkle_tree_insertion history/);
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
        (message?.type === 'event' || message?.type === 'caught_up');
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
