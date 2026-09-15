import http from 'node:http';

import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';

import { assert, isNullish } from '@hyperlane-xyz/utils';

import { closeServers } from '../../src/utils/shutdown.js';

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

    const metricsServer = http.createServer();
    await new Promise<void>((resolve) =>
      metricsServer.listen(0, '127.0.0.1', resolve),
    );
    const request = fetch(`http://127.0.0.1:${address.port}/hang`).catch(
      () => undefined,
    );
    await routeStarted;

    await closeServers(app, metricsServer, app.log, 20);
    await request;
    expect(app.server.listening).to.equal(false);
    expect(metricsServer.listening).to.equal(false);
  });
});
