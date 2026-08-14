import { expect } from 'chai';
import express from 'express';
import type { RequestHandler } from 'express';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { InterchainAccount, MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { CallCommitmentsService } from '../../src/services/CallCommitmentsService.js';
import {
  GCE_INGRESS_PROXY_HOPS,
  configureTrustProxy,
} from '../../src/utils/http.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

const loadBalancerIp = '35.191.0.1';
const clientOneIp = '192.0.2.1';
const clientTwoIp = '192.0.2.2';
const spoofedIp = '203.0.113.1';

function createServiceWithNoopHandlers(): CallCommitmentsService {
  const handler: RequestHandler = (req, res) => {
    res.status(200).json({ ip: req.ip });
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
    return new CallCommitmentsService(
      {
        serviceName: 'callCommitments',
        multiProvider: sinon.createStubInstance(MultiProvider),
        baseUrl: 'https://example.com/callCommitments',
      },
      sinon.createStubInstance(InterchainAccount),
    );
  } finally {
    stubs.forEach((stub) => stub.restore());
  }
}

async function startTestServer() {
  const app = express();
  configureTrustProxy(app);
  app.use(createServiceWithNoopHandlers().router);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(
    !isNullish(address) && typeof address !== 'string',
    'Expected TCP server address',
  );
  const { port } = address;

  return {
    server,
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

describe('configureTrustProxy', () => {
  it('configures the deployed GCE ingress hop count', () => {
    const app = express();
    const set = sinon.spy(app, 'set');

    configureTrustProxy(app);

    expect(set.calledWithExactly('trust proxy', GCE_INGRESS_PROXY_HOPS)).to.be
      .true;
  });
});

describe('Call commitments rate limiting', () => {
  let register: Registry;

  beforeEach(() => {
    register = new Registry();
    initializeMetrics(register);
  });

  afterEach(() => sinon.restore());

  it('isolates clients behind the GCE ingress', async () => {
    const { server, request } = await startTestServer();

    try {
      const firstResponse = await request(
        'POST',
        '/calls',
        clientOneIp,
        spoofedIp,
      );
      expect(firstResponse.status).to.equal(200);
      expect(await firstResponse.json()).to.deep.equal({ ip: clientOneIp });

      for (let i = 1; i < 20; i += 1) {
        expect((await request('POST', '/calls', clientOneIp)).status).to.equal(
          200,
        );
      }

      expect((await request('POST', '/calls', clientOneIp)).status).to.equal(
        429,
      );
      expect((await request('POST', '/calls', clientTwoIp)).status).to.equal(
        200,
      );
    } finally {
      server.close();
    }
  });

  it('uses independent read and write buckets', async () => {
    const { server, request } = await startTestServer();

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
      server.close();
    }
  });

  it('records bounded method and route labels', async () => {
    const { server, request } = await startTestServer();

    try {
      for (let i = 0; i <= 20; i += 1) {
        await request('GET', '/calldata/0xcommitment', clientOneIp);
      }

      expect(await register.metrics()).to.include(
        'hyperlane_offchain_lookup_server_rate_limited_requests{method="GET",route="/calldata/:commitment"} 1',
      );
    } finally {
      server.close();
    }
  });
});
