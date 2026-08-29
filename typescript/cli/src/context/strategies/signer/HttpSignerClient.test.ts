import { expect } from 'chai';
import { createServer, type Server } from 'node:http';

import { assert } from '@hyperlane-xyz/utils';

import { HttpSignerClient } from './HttpSignerClient.js';

const TOKEN = 'ab'.repeat(32);

async function getError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected promise to reject');
}

describe('HttpSignerClient response limits', () => {
  let server: Server | undefined;
  let serverUrl: URL;

  beforeEach(async () => {
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/content-length')) {
        response.setHeader('Content-Length', 300_000);
        response.end('{}');
        return;
      }
      response.write(`{"padding":"${'x'.repeat(150_000)}`);
      response.end(`${'x'.repeat(150_000)}"}`);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert(
      typeof address === 'object' && address !== null,
      'Expected HTTP test server address',
    );
    serverUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    const activeServer = server;
    server = undefined;
    if (!activeServer) return;
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      activeServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('rejects an oversized Content-Length before buffering the body', async () => {
    const error = await getError(
      new HttpSignerClient(serverUrl, TOKEN).getAccount('content-length'),
    );

    expect(error.message).to.include('exceeds 262144 bytes');
  });

  it('rejects an oversized chunked response while streaming', async () => {
    const error = await getError(
      new HttpSignerClient(serverUrl, TOKEN).getAccount('chunked'),
    );

    expect(error.message).to.include('exceeds 262144 bytes');
  });
});
