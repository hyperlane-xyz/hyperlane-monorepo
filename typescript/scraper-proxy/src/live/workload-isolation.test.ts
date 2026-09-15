import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { it } from 'node:test';

import type { QueryResultRow } from 'pg';
import { WebSocket } from 'ws';

import type { EventDatabase } from './event-websocket.js';
import { rawData } from './websocket-data.js';

process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';

void it('binds only the configured workload route and database channel', async () => {
  const { EventWebSocketServer } = await import('./event-websocket.js');
  for (const workload of [
    {
      channels: ['scraper_event'],
      disabledPath: '/messages',
      enabledPath: '/agents',
      routes: { agents: true, messages: false },
    },
    {
      channels: ['scraper_explorer_event'],
      disabledPath: '/agents',
      enabledPath: '/messages',
      routes: { agents: false, messages: true },
    },
  ]) {
    let listenedChannels: readonly string[] = [];
    const db: EventDatabase = {
      async listen(channels) {
        listenedChannels = channels;
        return async () => undefined;
      },
      async queryLive<T extends QueryResultRow>() {
        return [] as T[];
      },
    };
    const http = createServer();
    const events = new EventWebSocketServer(db, {}, workload.routes);
    await listen(http);
    const address = http.address();
    assert(address && typeof address !== 'string');
    const baseUrl = `ws://127.0.0.1:${address.port}`;
    try {
      await events.start(http);
      assert.deepEqual(listenedChannels, workload.channels);
      const enabled = new WebSocket(`${baseUrl}${workload.enabledPath}`, {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });
      assert.match(await firstMessage(enabled), /"type":"ready"/);
      enabled.close();
      await assert.rejects(
        firstMessage(new WebSocket(`${baseUrl}${workload.disabledPath}`)),
      );
      const snapshot = events.metricsSnapshot();
      assert.equal(
        workload.routes.agents
          ? snapshot.limits.messageConnections
          : snapshot.limits.agentConnections,
        0,
      );
    } finally {
      await events.stop();
      await close(http);
    }
  }
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function firstMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(rawData(data)));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed before a message')));
  });
}
