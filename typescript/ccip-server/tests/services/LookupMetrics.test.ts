import cors from '@fastify/cors';
import { expect } from 'chai';
import Fastify from 'fastify';
import { Registry } from 'prom-client';

import {
  initializeMetrics,
  registerLookupMetrics,
} from '../../src/utils/prometheus.js';

describe('lookup metrics', () => {
  it('excludes CORS preflights from service lookups', async () => {
    const register = new Registry();
    initializeMetrics(register);
    const app = Fastify();
    await app.register(cors);
    registerLookupMetrics(app, ['cctp']);
    app.post('/cctp/lookup', async () => ({ ok: true }));

    try {
      const preflight = await app.inject({
        headers: {
          'access-control-request-method': 'POST',
          origin: 'https://example.com',
        },
        method: 'OPTIONS',
        url: '/cctp/lookup',
      });
      expect(preflight.statusCode).to.equal(204);
      expect(await register.metrics()).not.to.include('service="cctp"');

      await app.inject({ method: 'POST', url: '/cctp/lookup' });
      expect(await register.metrics()).to.include(
        'hyperlane_offchain_lookup_server_http_requests{service="cctp",status_code="200"} 1',
      );
    } finally {
      await app.close();
    }
  });
});
