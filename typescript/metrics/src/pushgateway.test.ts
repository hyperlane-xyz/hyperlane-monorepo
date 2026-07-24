import { expect } from 'chai';
import { type Server, createServer } from 'http';
import { Registry } from 'prom-client';

import { submitMetrics } from './pushgateway.js';

async function getRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(
      `Promise rejected with a non-Error value: ${String(error)}`,
    );
  }

  throw new Error('Expected promise to reject');
}

describe('submitMetrics', () => {
  let server: Server;
  let gatewayUrl: string;
  let responseStatus = 204;
  let requestCount = 0;
  let previousGatewayUrl: string | undefined;

  before(async () => {
    previousGatewayUrl = process.env['PROMETHEUS_PUSH_GATEWAY'];
    server = createServer((_request, response) => {
      requestCount += 1;
      response.statusCode = responseStatus;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test PushGateway did not bind to a TCP port');
    }
    gatewayUrl = `http://127.0.0.1:${address.port}`;
    process.env['PROMETHEUS_PUSH_GATEWAY'] = gatewayUrl;
  });

  after(async () => {
    if (previousGatewayUrl === undefined) {
      delete process.env['PROMETHEUS_PUSH_GATEWAY'];
    } else {
      process.env['PROMETHEUS_PUSH_GATEWAY'] = previousGatewayUrl;
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }),
      );
    }
  });

  it('resolves for a 2xx response when throwOnError is enabled', async () => {
    responseStatus = 204;
    const previousRequestCount = requestCount;

    await submitMetrics(new Registry(), 'test', { throwOnError: true });

    expect(requestCount).to.equal(previousRequestCount + 1);
  });

  it('rejects a 3xx response when throwOnError is enabled', async () => {
    responseStatus = 302;

    const rejection = await getRejection(
      submitMetrics(new Registry(), 'test', { throwOnError: true }),
    );

    expect(rejection.message).to.include('PushGateway returned status 302');
  });

  it('rejects a 5xx response when throwOnError is enabled', async () => {
    responseStatus = 503;

    const rejection = await getRejection(
      submitMetrics(new Registry(), 'test', { throwOnError: true }),
    );

    expect(rejection.message).to.include('PushGateway returned status 503');
  });

  it('preserves best-effort behavior for non-2xx responses', async () => {
    responseStatus = 503;
    const previousRequestCount = requestCount;

    await submitMetrics(new Registry(), 'test');

    expect(requestCount).to.equal(previousRequestCount + 1);
  });

  it('rejects network failures only when throwOnError is enabled', async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );

    const rejection = await getRejection(
      submitMetrics(new Registry(), 'test', { throwOnError: true }),
    );

    expect(rejection).to.be.instanceOf(Error);
    await submitMetrics(new Registry(), 'test');
  });
});
