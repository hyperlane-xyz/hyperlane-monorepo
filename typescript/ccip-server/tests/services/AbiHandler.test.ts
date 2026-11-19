import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';

import { CctpService__factory } from '@hyperlane-xyz/core';

import { type CcipApp, MAX_CCIP_PARAMETER_LENGTH } from '../../src/http.js';
import { VaaPendingError } from '../../src/services/WormholeVaaFetcher.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../../src/utils/abiHandler.js';
import {
  AttestationPendingError,
  CommitmentAccessDeniedError,
} from '../../src/utils/errors.js';
import { RpcUnavailableError } from '../../src/utils/rpcErrors.js';
import {
  nonCanonicalCallData,
  respondWithAbiError,
} from '../utils/abiHandler.js';

const SECRET_HOST = 'secret-host.invalid';
const SECRET_PATH = 'apikey-SECRET123';
const ETHERS_SERVER_ERROR =
  'missing response (requestBody="{\\"method\\":\\"eth_call\\"}", requestMethod="POST", ' +
  `serverError={"errno":-3008,"code":"ENOTFOUND","syscall":"getaddrinfo","hostname":"${SECRET_HOST}"}, ` +
  `url="https://${SECRET_HOST}/${SECRET_PATH}", code=SERVER_ERROR, version=web/5.8.0)`;
const VAA_ID = `2/${'00'.repeat(32)}/7`;

describe('ABI handler error responses', () => {
  interface Case {
    name: string;
    error: Error;
    statusCode: number;
    body: { error: string };
  }
  const cases: Case[] = [
    {
      name: 'returns a fixed body for an unavailable RPC',
      error: new RpcUnavailableError(new Error(ETHERS_SERVER_ERROR)),
      statusCode: 500,
      body: { error: 'Internal server error' },
    },
    {
      name: 'returns a fixed body for an ordinary error',
      error: new Error(`call to https://${SECRET_HOST}/${SECRET_PATH} failed`),
      statusCode: 500,
      body: { error: 'Internal server error' },
    },
    {
      name: 'returns the message of a pending CCTP attestation',
      error: new AttestationPendingError(),
      statusCode: 500,
      body: { error: 'CCTP attestation is pending' },
    },
    {
      name: 'returns the message of a pending Wormhole VAA',
      error: new VaaPendingError(VAA_ID),
      statusCode: 500,
      body: { error: `VAA ${VAA_ID} is pending Guardian signatures` },
    },
    {
      name: 'returns the message of a denied commitment read',
      error: new CommitmentAccessDeniedError(),
      statusCode: 403,
      body: { error: 'Signer not authorized for this commitment' },
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { response, lines } = await respondWithAbiError(c.error, 'debug');
      expect(response.statusCode).to.equal(c.statusCode);
      expect(response.json()).to.deep.equal(c.body);
      for (const text of [response.body, ...lines]) {
        expect(text).to.not.include(SECRET_HOST);
        expect(text).to.not.include(SECRET_PATH);
      }
    });
  }

  it('logs the redacted RPC error with its stack frames', async () => {
    const { lines } = await respondWithAbiError(
      new RpcUnavailableError(new Error(ETHERS_SERVER_ERROR)),
    );
    const handlerErrors = lines
      .filter((line) => line.includes('Error in ABI handler'))
      .map((line): unknown => JSON.parse(line));
    expect(handlerErrors).to.have.length(1);
    const [entry] = handlerErrors;
    expect(entry).to.be.an('object');
    expect(entry).to.have.property('error').that.includes('<redacted-url>');
    expect(entry).to.have.property('error').that.includes('code=SERVER_ERROR');
    expect(entry)
      .to.have.property('error')
      .that.includes('"hostname":"<redacted-host>"');
    expect(entry).to.have.property('stack').that.includes('AbiHandler.test.ts');
  });
});

describe('ABI handler call data canonicality', () => {
  const sender = '0x' + '03'.repeat(20);
  const canonical = CctpService__factory.createInterface().encodeFunctionData(
    'getCCTPAttestation',
    ['0x1234'],
  );

  async function cctpApp() {
    const service = sinon.stub().resolves(['0x12', '0x34']);
    const app: CcipApp = Fastify({
      loggerInstance: pino({ level: 'silent' }),
      routerOptions: { maxParamLength: MAX_CCIP_PARAMETER_LENGTH },
    });
    const handler = createAbiHandler(
      CctpService__factory,
      'getCCTPAttestation',
      service,
    );
    app.post<AbiRoute>('/', ABI_ROUTE_OPTIONS, handler);
    app.get<AbiRoute>('/:sender/:callData.json', ABI_ROUTE_OPTIONS, handler);
    await app.ready();
    return { app, service };
  }

  it('serves canonical call data with the decoded message', async () => {
    const { app, service } = await cctpApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/',
        payload: { data: canonical },
      });
      expect(response.statusCode).to.equal(200);
      sinon.assert.calledOnce(service);
      expect(service.firstCall.args[0]).to.equal('0x1234');
    } finally {
      await app.close();
    }
  });

  for (const c of nonCanonicalCallData(canonical)) {
    it(`rejects call data with ${c.name}`, async () => {
      const { app, service } = await cctpApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/',
          payload: { data: c.data },
        });
        expect(response.statusCode).to.equal(400);
        expect(response.json()).to.deep.equal({
          error: 'Non-canonical callData',
        });
        sinon.assert.notCalled(service);
      } finally {
        await app.close();
      }
    });
  }

  it('rejects non-canonical call data in the request path', async () => {
    const { app, service } = await cctpApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/${sender}/${canonical}00.json`,
      });
      expect(response.statusCode).to.equal(400);
      expect(response.json()).to.deep.equal({
        error: 'Non-canonical callData',
      });
      sinon.assert.notCalled(service);

      const canonicalResponse = await app.inject({
        method: 'GET',
        url: `/${sender}/${canonical}.json`,
      });
      expect(canonicalResponse.statusCode).to.equal(200);
      sinon.assert.calledOnce(service);
    } finally {
      await app.close();
    }
  });
});
