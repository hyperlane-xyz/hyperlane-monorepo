import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, it } from 'node:test';

import { WebSocket } from 'ws';
import type { QueryResultRow } from 'pg';

import type { EventDatabase, EventWebSocketServer } from './event-websocket.js';
import { rawData } from './websocket-data.js';

const hookA = '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hookB = '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const msgId = `\\x${'01'.repeat(32)}`;
const msgBody = 'x'.repeat(300);
const rows = new Map([
  ['1', row(hookB)],
  ['2', row(hookA)],
]);
let notify: (channel: string, payload?: string) => void;

const db: EventDatabase = {
  async listen(_channels, handler) {
    notify = handler;
    return async () => undefined;
  },
  async queryLive<T>(sql, values = []) {
    if (sql.includes('MIN(')) return queryRows<T>([{ first: '0', last: '0' }]);
    if (sql.includes('"message_view"')) {
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
    if (sql.includes('ORDER BY "leaf_index"'))
      return queryRows<T>([row(hookA)]);
    if (!sql.includes('notification_id')) return [];
    return queryRows<T>(
      stringArray(values[0]).map((id) => ({
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
  events = new EventWebSocketServer(db, true, {
    maxAgentClients: 1,
    maxCatchUpRows: 0,
    maxExplorerClients: 4,
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
  const explorers = Array.from({ length: 4 }, () => new WebSocket(messagesUrl));
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
  explorers.forEach((socket) => socket.close());
  agent.close();
  await waitUntil(() =>
    [...explorers, agent].every(
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
              cursors: [{ address: hookA, afterSequence: '-1', domain: 1 }],
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

function row(merkle_tree_hook: string): Record<string, unknown> {
  return {
    block_number: '1',
    domain: 1,
    leaf_index: 1,
    merkle_tree_hook,
    message_id: msgId,
  };
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
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
