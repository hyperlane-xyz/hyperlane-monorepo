import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, it } from 'node:test';

import { WebSocket } from 'ws';

import { type EventDatabase, EventWebSocketServer } from './event-websocket.js';

const hookA = '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hookB = '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
    if (sql.includes('MIN(')) return [{ first: '0', last: '0' }] as T[];
    if (!sql.includes('notification_id')) return [];
    return (values[0] as string[]).map((id) => ({
      notification_id: id,
      ...rows.get(id),
    })) as T[];
  },
};

const http = createServer();
const events = new EventWebSocketServer(db);
let url: string;

before(async () => {
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  url = `ws://127.0.0.1:${address.port}/ws`;
  await events.start(http);
});

after(async () => {
  await events.stop();
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

void it('only emits addresses named by sequence cursors', async () => {
  const socket = new WebSocket(url);
  const messages: Record<string, unknown>[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(rawData(data)) as Record<string, unknown>;
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
  assert.equal((event.data as Record<string, unknown>).merkle_tree_hook, hookA);
  assert.equal(messages.filter(({ type }) => type === 'event').length, 1);
  socket.close();
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
});

function row(merkle_tree_hook: string): Record<string, unknown> {
  return {
    block_number: '1',
    domain: 1,
    leaf_index: 1,
    merkle_tree_hook,
    message_id: '\\x01',
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

function rawData(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
