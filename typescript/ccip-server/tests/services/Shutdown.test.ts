import http from 'node:http';
import type { Server } from 'node:http';

import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';

import { assert, isNullish } from '@hyperlane-xyz/utils';

import { CCIP_KEEP_ALIVE_TIMEOUT_MS } from '../../src/http.js';
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

  it('closes idle keep-alive connections without waiting for the grace period', async () => {
    const app = Fastify({
      keepAliveTimeout: CCIP_KEEP_ALIVE_TIMEOUT_MS,
      loggerInstance: pino({ level: 'silent' }),
    });
    app.get('/health', async () => 'OK');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(
      !isNullish(address) && typeof address !== 'string',
      'Expected TCP server address',
    );

    const agent = new http.Agent({ keepAlive: true });
    const statusCode = await new Promise<number | undefined>(
      (resolve, reject) => {
        http
          .get(`http://127.0.0.1:${address.port}/health`, { agent }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          })
          .on('error', reject);
      },
    );
    expect(statusCode).to.equal(200);
    expect(Object.keys(agent.freeSockets)).to.have.length(1);

    const metricsServer = await startMetricsServer();
    const graceMs = 5_000;
    const startedAt = Date.now();
    await closeServers(app, metricsServer, app.log, {
      graceMs,
      hardMs: graceMs * 2,
    });
    agent.destroy();
    expect(Date.now() - startedAt).to.be.lessThan(graceMs);
    expect(app.server.listening).to.equal(false);
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
