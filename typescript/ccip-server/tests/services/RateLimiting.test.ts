import { expect } from 'chai';
import Fastify, { type FastifyReply } from 'fastify';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { InterchainAccount, MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import type { CcipApp, CcipRequest } from '../../src/http.js';
import { CallCommitmentsService } from '../../src/services/CallCommitmentsService.js';
import { trustGceIngressProxy } from '../../src/utils/http.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';
import { registerRateLimiting } from '../../src/utils/rateLimit.js';

const loadBalancerIp = '35.191.0.1';
const clientOneIp = '192.0.2.1';
const clientTwoIp = '192.0.2.2';
const spoofedIp = '203.0.113.1';

function registerServiceWithNoopHandlers(app: CcipApp): void {
  const handler = async (req: CcipRequest, reply: FastifyReply) => {
    return reply.code(200).send({ ip: req.ip });
  };
  const stubs = [
    sinon
      .stub(CallCommitmentsService.prototype, 'handleCommitment')
      .callsFake(handler),
    sinon
      .stub(CallCommitmentsService.prototype, 'handleCheckCommitment')
      .callsFake(handler),
    sinon
      .stub(CallCommitmentsService.prototype, 'handleCalldataPost')
      .callsFake(handler),
    sinon
      .stub(CallCommitmentsService.prototype, 'handleCalldataGet')
      .callsFake(handler),
  ];

  try {
    const service = new CallCommitmentsService(
      {
        serviceName: 'callCommitments',
        multiProvider: sinon.createStubInstance(MultiProvider),
        baseUrl: 'https://example.com/callCommitments',
      },
      sinon.createStubInstance(InterchainAccount),
    );
    service.registerRoutes(app, '');
  } finally {
    stubs.forEach((stub) => stub.restore());
  }
}

async function startTestServer() {
  const app = Fastify({
    loggerInstance: pino({ level: 'silent' }),
    requestTimeout: 300_000,
    trustProxy: trustGceIngressProxy,
  });
  await registerRateLimiting(app);
  registerServiceWithNoopHandlers(app);

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(
    !isNullish(address) && typeof address !== 'string',
    'Expected TCP server address',
  );
  const { port } = address;

  return {
    app,
    request: (
      method: 'GET' | 'POST',
      path: string,
      clientIp: string,
      suppliedXff?: string,
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          'X-Forwarded-For': [suppliedXff, clientIp, loadBalancerIp]
            .filter(Boolean)
            .join(', '),
        },
      }),
  };
}

describe('Call commitments rate limiting', () => {
  let register: Registry;

  beforeEach(() => {
    register = new Registry();
    initializeMetrics(register);
  });

  afterEach(() => sinon.restore());

  it('isolates clients behind the GCE ingress', async () => {
    const { app, request } = await startTestServer();

    try {
      const firstResponse = await request(
        'POST',
        '/calls',
        clientOneIp,
        spoofedIp,
      );
      expect(firstResponse.status).to.equal(200);
      expect(await firstResponse.json()).to.deep.equal({ ip: clientOneIp });
      expect(firstResponse.headers.get('ratelimit-policy')).to.equal('20;w=60');

      for (let i = 1; i < 20; i += 1) {
        expect((await request('POST', '/calls', clientOneIp)).status).to.equal(
          200,
        );
      }

      expect((await request('POST', '/calls', clientOneIp)).status).to.equal(
        429,
      );
      expect(
        await (await request('POST', '/calls', clientOneIp)).json(),
      ).to.deep.equal({ error: 'Too many requests' });
      expect((await request('POST', '/calls', clientTwoIp)).status).to.equal(
        200,
      );
    } finally {
      await app.close();
    }
  });

  it('groups IPv6 clients by /56', async () => {
    const { app, request } = await startTestServer();

    try {
      for (let i = 0; i < 20; i += 1) {
        expect(
          (await request('POST', '/calls', '2001:db8:1234:5600::1')).status,
        ).to.equal(200);
      }
      expect(
        (await request('POST', '/calls', '2001:db8:1234:56ff::1')).status,
      ).to.equal(429);
    } finally {
      await app.close();
    }
  });

  it('ignores forwarding headers from untrusted direct peers', async () => {
    const app = Fastify({ trustProxy: trustGceIngressProxy });
    app.get('/', async (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        headers: { 'x-forwarded-for': `${clientOneIp}, ${loadBalancerIp}` },
        method: 'GET',
        remoteAddress: '203.0.113.10',
        url: '/',
      });
      expect(response.json()).to.deep.equal({ ip: '203.0.113.10' });
    } finally {
      await app.close();
    }
  });

  it('returns a generic response for unexpected errors', async () => {
    const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
    await registerRateLimiting(app);
    app.get('/failure', async () => {
      throw new Error('sensitive internal detail');
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/failure' });
      expect(response.statusCode).to.equal(500);
      expect(response.json()).to.deep.equal({ error: 'Internal server error' });
      expect(response.body).not.to.include('sensitive internal detail');
    } finally {
      await app.close();
    }
  });

  it('uses independent read and write buckets', async () => {
    const { app, request } = await startTestServer();

    try {
      for (let i = 0; i < 20; i += 1) {
        expect((await request('POST', '/calls', clientOneIp)).status).to.equal(
          200,
        );
      }

      expect((await request('POST', '/calldata', clientOneIp)).status).to.equal(
        429,
      );
      expect(
        (await request('GET', '/calls/0xcommitment', clientOneIp)).status,
      ).to.equal(200);
    } finally {
      await app.close();
    }
  });

  it('records bounded method and route labels', async () => {
    const { app, request } = await startTestServer();

    try {
      for (let i = 0; i <= 20; i += 1) {
        await request('GET', '/calldata/0xcommitment', clientOneIp);
      }

      expect(await register.metrics()).to.include(
        'hyperlane_offchain_lookup_server_rate_limited_requests{method="GET",route="/calldata/:commitment"} 1',
      );
    } finally {
      await app.close();
    }
  });
});
