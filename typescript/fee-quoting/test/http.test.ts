import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';
import { Registry } from 'prom-client';

import type { FeeQuotingApp } from '../src/http.js';
import { createMetrics } from '../src/middleware/metrics.js';
import { registerHealthRoute } from '../src/routes/health.js';

describe('HTTP server', () => {
  let app: FeeQuotingApp;
  let register: Registry;
  let ready: boolean;

  beforeEach(async () => {
    ready = false;
    register = new Registry();
    app = Fastify({ loggerInstance: pino({ level: 'silent' }) });

    const metrics = createMetrics(register);
    app.addHook('onRequest', metrics.onRequest);
    app.addHook('onResponse', metrics.onResponse);
    registerHealthRoute(app, () => ready);
    app.get('/quote/test', async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    register.clear();
  });

  it('reports readiness', async () => {
    const starting = await app.inject({ method: 'GET', url: '/health' });
    expect(starting.statusCode).to.equal(503);
    expect(starting.json()).to.deep.equal({ status: 'starting' });

    ready = true;
    const healthy = await app.inject({ method: 'GET', url: '/health' });
    expect(healthy.statusCode).to.equal(200);
    expect(healthy.json()).to.deep.equal({ status: 'ok' });
  });

  it('preserves request metric labels', async () => {
    const response = await app.inject({ method: 'GET', url: '/quote/test' });
    expect(response.statusCode).to.equal(200);

    const output = await register.metrics();
    expect(output).to.include(
      'hyperlane_fee_quoting_http_requests_total{method="GET",endpoint="/test",status="200"} 1',
    );
    expect(output).to.include(
      'hyperlane_fee_quoting_http_request_duration_seconds_count{method="GET",endpoint="/test"} 1',
    );
  });
});
