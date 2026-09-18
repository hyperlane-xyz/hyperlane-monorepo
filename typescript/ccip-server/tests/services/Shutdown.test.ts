import http from 'node:http';
import type { Server } from 'node:http';

import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';

import { assert, isNullish } from '@hyperlane-xyz/utils';

import { closeServers } from '../../src/utils/shutdown.js';

async function startMetricsServer(): Promise<Server> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('server shutdown', () => {
  it('forces stalled requests closed after the grace period', async () => {
    let markRouteStarted: (() => void) | undefined;
    const routeStarted = new Promise<void>((resolve) => {
      markRouteStarted = resolve;
    });
    const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
    app.get('/hang', async () => {
      markRouteStarted?.();
      return new Promise(() => {});
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(
      !isNullish(address) && typeof address !== 'string',
      'Expected TCP server address',
    );

    const metricsServer = await startMetricsServer();
    const request = fetch(`http://127.0.0.1:${address.port}/hang`).catch(
      () => undefined,
    );
    await routeStarted;

    await closeServers(app, metricsServer, app.log, {
      graceMs: 20,
      hardMs: 100,
    });
    await request;
    expect(app.server.listening).to.equal(false);
    expect(metricsServer.listening).to.equal(false);
  });

  it('hard exits when a close hook stalls', async () => {
    const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
    app.addHook('onClose', async () => new Promise<void>(() => {}));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const metricsServer = await startMetricsServer();
    const exitCode = new Promise<number>((resolve) => {
      void closeServers(app, metricsServer, app.log, {
        forceExit: resolve,
        graceMs: 10,
        hardMs: 20,
      });
    });

    expect(await exitCode).to.equal(1);
    expect(app.server.listening).to.equal(false);
    expect(metricsServer.listening).to.equal(false);
  });
});
