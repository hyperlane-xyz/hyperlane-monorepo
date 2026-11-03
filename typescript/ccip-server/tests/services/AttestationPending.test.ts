import { expect } from 'chai';
import Fastify from 'fastify';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { CctpService__factory } from '@hyperlane-xyz/core';

import { type CcipApp, MAX_CCIP_PARAMETER_LENGTH } from '../../src/http.js';
import { CCTPAttestationService } from '../../src/services/CCTPAttestationService.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../../src/utils/abiHandler.js';
import { AttestationPendingError } from '../../src/utils/errors.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

function captureLogger(level = 'info') {
  const lines: string[] = [];
  const logger = pino(
    { level },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected rejection');
}

describe('CCTP pending attestation logging', () => {
  const cctpMessage = `0x${'00'.repeat(8)}`;
  const transactionHash = `0x${'11'.repeat(32)}`;
  const messageId = `0x${'22'.repeat(32)}`;
  const service = new CCTPAttestationService('test', 'https://example.com');

  beforeEach(() => {
    initializeMetrics(new Registry());
  });
  afterEach(() => {
    sinon.restore();
  });

  it('retains retry errors while suppressing routine pending payload logs at info', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          messages: [{ message: cctpMessage, attestation: 'PENDING' }],
        }),
      ),
    );
    const { logger, lines } = captureLogger();
    const error = await rejected(
      service.getAttestation(cctpMessage, transactionHash, messageId, logger),
    );
    expect(error).to.be.instanceOf(AttestationPendingError);
    expect(error.message).to.equal('CCTP attestation is pending');
    expect(lines).to.have.length(0);
  });

  it('keeps pending details available at debug level', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          messages: [{ message: cctpMessage, attestation: 'PENDING' }],
        }),
      ),
    );
    const { logger, lines } = captureLogger('debug');
    await rejected(
      service.getAttestation(cctpMessage, transactionHash, messageId, logger),
    );
    expect(lines).to.have.length(1);
    expect(lines[0]).to.include('CCTP attestation is pending');
    expect(lines[0]).to.include(cctpMessage);
  });

  it('keeps actionable Circle delay reasons at error level', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          messages: [
            {
              message: cctpMessage,
              attestation: 'PENDING',
              delayReason: 'insufficient_fee',
            },
          ],
        }),
      ),
    );
    const { logger, lines } = captureLogger();
    const error = await rejected(
      service.getAttestation(cctpMessage, transactionHash, messageId, logger),
    );
    expect(error).to.be.instanceOf(AttestationPendingError);
    expect(lines).to.have.length(1);
    expect(lines[0]).to.include('"level":50');
    expect(lines[0]).to.include('insufficient_fee');
  });

  it('classifies a not-yet-found attestation as pending', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null, { status: 404 }));
    const { logger } = captureLogger();
    expect(
      await rejected(
        service.getAttestation(cctpMessage, transactionHash, messageId, logger),
      ),
    ).to.be.instanceOf(AttestationPendingError);
  });

  it('does not suppress genuine upstream failures', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null, { status: 500, statusText: 'Unavailable' }));
    const { logger, lines } = captureLogger();
    const error = await rejected(
      service.getAttestation(cctpMessage, transactionHash, messageId, logger),
    );
    expect(error).not.to.be.instanceOf(AttestationPendingError);
    expect(error.message).to.equal(
      'CCTP attestation request failed: Unavailable',
    );
    expect(lines[0]).to.include('"level":50');
  });

  it("accepts CCIP-read GET calldata above Fastify's default parameter limit", async () => {
    const { logger } = captureLogger();
    const app: CcipApp = Fastify({
      loggerInstance: logger,
      routerOptions: { maxParamLength: MAX_CCIP_PARAMETER_LENGTH },
    });
    app.get<AbiRoute>(
      '/getCctpAttestation/:sender/:callData.json',
      ABI_ROUTE_OPTIONS,
      createAbiHandler(CctpService__factory, 'getCCTPAttestation', async () => [
        '0xabcd',
        '0x1234',
      ]),
    );
    await app.ready();
    try {
      const iface = CctpService__factory.createInterface();
      const data = iface.encodeFunctionData('getCCTPAttestation', ['0x1234']);
      expect(data.length).to.be.greaterThan(100);

      const response = await app.inject({
        method: 'GET',
        url: `/getCctpAttestation/${'0x' + '11'.repeat(20)}/${data}.json`,
      });
      expect(response.statusCode, response.body).to.equal(200);
      expect(response.json()).to.deep.equal({
        data: iface.encodeFunctionResult('getCCTPAttestation', [
          '0xabcd',
          '0x1234',
        ]),
      });
    } finally {
      await app.close();
    }
  });

  for (const expected of [true, false]) {
    it(`preserves HTTP status and body for ${expected ? 'typed pending' : 'ordinary'} errors`, async () => {
      const { logger, lines } = captureLogger();
      const error = expected
        ? new AttestationPendingError()
        : new Error('CCTP attestation is pending');
      const app: CcipApp = Fastify({
        loggerInstance: logger,
        routerOptions: { maxParamLength: MAX_CCIP_PARAMETER_LENGTH },
      });
      app.post<AbiRoute>(
        '/',
        ABI_ROUTE_OPTIONS,
        createAbiHandler(CctpService__factory, 'getCCTPAttestation', () =>
          Promise.reject(error),
        ),
      );
      await app.ready();
      try {
        const data = CctpService__factory.createInterface().encodeFunctionData(
          'getCCTPAttestation',
          ['0x1234'],
        );
        const response = await app.inject({
          method: 'POST',
          url: '/',
          payload: { data },
        });
        expect(response.statusCode).to.equal(500);
        expect(response.json()).to.deep.equal({
          error: 'CCTP attestation is pending',
        });
        const handlerErrors = lines.filter((line) =>
          line.includes('Error in ABI handler'),
        );
        expect(handlerErrors).to.have.length(expected ? 0 : 1);
        expect(
          lines.some((line) => line.includes('Processing ABI handler request')),
        ).to.equal(true);
      } finally {
        await app.close();
      }
    });
  }
});
