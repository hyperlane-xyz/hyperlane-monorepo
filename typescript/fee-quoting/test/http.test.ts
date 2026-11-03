import { expect } from 'chai';
import cors from '@fastify/cors';
import { pino } from 'pino';
import { Registry } from 'prom-client';

import { createApp } from '../FeeQuotingServer.js';
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
    app = createApp(pino({ level: 'silent' }));

    const metrics = createMetrics(register);
    app.addHook('onRequest', metrics.onRequest);
    app.addHook('onResponse', metrics.onResponse);
    await app.register(cors);
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

  it('records CORS preflight counts and durations together', async () => {
    const response = await app.inject({
      headers: {
        'access-control-request-method': 'GET',
        origin: 'https://example.com',
      },
      method: 'OPTIONS',
      url: '/quote/test',
    });
    expect(response.statusCode).to.equal(204);

    const output = await register.metrics();
    expect(output).to.match(
      /hyperlane_fee_quoting_http_requests_total\{method="OPTIONS",endpoint="[^"]+",status="204"\} 1/,
    );
    expect(output).to.match(
      /hyperlane_fee_quoting_http_request_duration_seconds_count\{method="OPTIONS",endpoint="[^"]+"\} 1/,
    );
  });

  it('preserves timeout and case-insensitive trailing-slash routing', async () => {
    expect(app.server.requestTimeout).to.equal(300_000);
    const response = await app.inject({ method: 'GET', url: '/QUOTE/TEST/' });
    expect(response.statusCode).to.equal(200);
  });

  it('emits one completion record with latency and errors', async () => {
    const lines: string[] = [];
    const loggedApp = createApp(
      pino({ level: 'info' }, { write: (line) => lines.push(line) }),
    );
    loggedApp.get('/ok', async () => ({ ok: true }));
    loggedApp.get('/fail', async () => {
      throw new Error('test failure');
    });
    try {
      await loggedApp.inject({ method: 'GET', url: '/ok' });
      await loggedApp.inject({ method: 'GET', url: '/fail' });
      expect(lines.filter((line) => line.includes('"incoming request"'))).to.be
        .empty;
      expect(
        lines.filter((line) => line.includes('"request completed"')),
      ).to.have.length(1);
      const [failed] = lines.filter((line) =>
        line.includes('"request errored"'),
      );
      expect(failed).to.include('"message":"test failure"');
      expect(failed).to.match(/"responseTime":\d/);
    } finally {
      await loggedApp.close();
    }
  });
});
