import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { BroadcastQueue } from './broadcast-queue.js';

for (const exclusiveBytes of [0, 1]) {
  void it(`reclaims jointly held backlog with ${exclusiveBytes} exclusive bytes`, async (t) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    t.after(() => {
      for (const socket of server.clients) socket.terminate();
      server.close();
    });
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    async function connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      t.after(() => socket.terminate());
      await once(socket, 'open');
      return socket;
    }
    const peers = [await connect(), await connect()];
    const healthy = await connect();
    const stopped: WebSocket[] = [];
    const sent: Buffer[] = [];
    const queue = new BroadcastQueue(
      {
        async send(socket, frame) {
          if (socket === healthy) {
            sent.push(frame);
            return true;
          }
          return new Promise(() => {});
        },
        fail(socket) {
          stopped.push(socket);
        },
      },
      { messages: 3, bytes: 128, totalBytes: 64 },
    );
    const shared = Buffer.alloc(64 - exclusiveBytes);
    for (const peer of peers) {
      queue.enqueue(peer, [Buffer.alloc(1)]);
      queue.enqueue(peer, [shared]);
    }
    if (exclusiveBytes) queue.enqueue(peers[0], [Buffer.alloc(exclusiveBytes)]);
    assert.equal(queue.metrics().bytes, 64);

    const frame = Buffer.alloc(2);
    assert(queue.enqueue(healthy, [frame]));
    assert.deepEqual(stopped, peers);
    assert.deepEqual(sent, [frame]);
    assert.equal(queue.metrics().bytes, 0);
  });
}
