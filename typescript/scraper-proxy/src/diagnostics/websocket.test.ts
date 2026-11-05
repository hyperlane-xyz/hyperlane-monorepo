import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { it, type TestContext } from 'node:test';

import { WebSocket } from 'ws';
import { z } from 'zod';

import type { EventDatabase } from '../live/event-websocket.js';
import { rawData } from '../live/websocket-data.js';
import { DiagnosticsService } from './service.js';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';
const id = `0x${'01'.repeat(32)}`;
const frame = z.object({
  type: z.string(),
  message: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
  data: z
    .object({ message_id: z.string(), activities: z.array(z.unknown()) })
    .optional(),
});

// Shared lifecycle and frame handling keep the tests focused on behavior.
async function server(
  t: TestContext,
  diagnostics?: DiagnosticsService,
  queryLive: EventDatabase['queryLive'] = async () => [],
) {
  const { EventWebSocketServer } = await import('../live/event-websocket.js');
  const http = createServer();
  const events = new EventWebSocketServer(
    { listen: async () => async () => undefined, queryLive },
    {},
    diagnostics,
  );
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await events.stop();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  await events.start(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert(address && typeof address !== 'string');
  return (query = '') => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/messages${query}`,
    );
    sockets.push(socket);
    return socket;
  };
}

function framesUntil(
  socket: WebSocket,
  type: string,
): Promise<z.infer<typeof frame>[]> {
  return new Promise((resolve, reject) => {
    const frames: z.infer<typeof frame>[] = [];
    socket.once('error', reject);
    socket.on('message', (raw) => {
      try {
        const value = frame.parse(JSON.parse(rawData(raw)));
        frames.push(value);
        if (value.type === type) resolve(frames);
      } catch (error) {
        reject(new Error('Invalid WebSocket frame', { cause: error }));
      }
    });
  });
}

void it(
  'negotiates diagnostics on the existing socket without querying for opt-out clients',
  { timeout: 10_000 },
  async (t) => {
    let reads = 0;
    const connect = await server(
      t,
      new DiagnosticsService({
        query: async () => {
          reads++;
          return [];
        },
      }),
    );
    const [ready] = await framesUntil(connect(), 'ready');
    assert.deepEqual(ready?.eventTypes, ['message_upsert']);
    assert.equal(reads, 0);
    const received = await framesUntil(
      connect(`?diagnostics=true&messageIds=${id}`),
      'diagnostics',
    );
    assert(received[0]?.eventTypes?.includes('diagnostics'));
    assert.equal(received[1]?.data?.message_id, id);
    assert.deepEqual(received[1]?.data?.activities, []);
    assert.equal(reads, 1);
  },
);

void it(
  'keeps normal message updates available when diagnostics are not configured',
  { timeout: 5_000 },
  async (t) => {
    const connect = await server(t);
    const socket = connect(`?diagnostics=true&messageIds=${id}`);
    const messages = await framesUntil(socket, 'diagnostics_unavailable');
    assert.deepEqual(
      messages.map((frame) => frame.type),
      ['ready', 'diagnostics_unavailable'],
    );
    assert.equal(socket.readyState, WebSocket.OPEN);
  },
);

void it(
  'does not start diagnostics for a peer that closes during initialization',
  { timeout: 5_000 },
  async (t) => {
    let release = () => {};
    let initialized = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    let reads = 0;
    const connect = await server(
      t,
      new DiagnosticsService({
        query: async () => {
          reads++;
          return [];
        },
      }),
      async () => {
        initialized();
        await held;
        return [];
      },
    );
    try {
      const socket = connect(`?blocks=true&diagnostics=true&messageIds=${id}`);
      await Promise.all([started, once(socket, 'open')]);
      const closed = once(socket, 'close');
      socket.close();
      await closed;
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 0);
    } finally {
      release();
    }
  },
);
