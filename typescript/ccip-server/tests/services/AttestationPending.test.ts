import { expect } from 'chai';
import express from 'express';
import { pino } from 'pino';
import pinoHttp from 'pino-http';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { CctpService__factory } from '@hyperlane-xyz/core';

import { CCTPAttestationService } from '../../src/services/CCTPAttestationService.js';
import { createAbiHandler } from '../../src/utils/abiHandler.js';
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

  for (const expected of [true, false]) {
    it(`preserves HTTP status and body for ${expected ? 'typed pending' : 'ordinary'} errors`, async () => {
      const { logger, lines } = captureLogger();
      const error = expected
        ? new AttestationPendingError()
        : new Error('CCTP attestation is pending');
      const app = express();
      app.use(express.json());
      app.use(pinoHttp({ logger }));
      app.post(
        '/',
        createAbiHandler(CctpService__factory, 'getCCTPAttestation', () =>
          Promise.reject(error),
        ),
      );
      const server = app.listen(0);
      await new Promise<void>((resolve) => {
        server.once('listening', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected TCP server');
        const data = CctpService__factory.createInterface().encodeFunctionData(
          'getCCTPAttestation',
          ['0x1234'],
        );
        const response = await fetch(`http://127.0.0.1:${address.port}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
        expect(response.status).to.equal(500);
        expect(await response.json()).to.deep.equal({
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
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    });
  }
});
