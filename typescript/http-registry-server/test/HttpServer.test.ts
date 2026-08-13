import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createServer } from 'node:net';

import { PartialRegistry } from '@hyperlane-xyz/registry';

import { HttpServer } from '../HttpServer.js';

chaiUse(chaiAsPromised);

async function bindPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('expected a bound TCP address');
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('HttpServer.start', () => {
  it('rejects when the target port is already in use', async () => {
    const blocker = await bindPort();
    const httpServer = await HttpServer.create(
      async () => new PartialRegistry({}),
    );

    try {
      await expect(httpServer.start(String(blocker.port))).to.be.rejected;
    } finally {
      await blocker.close();
    }
  });
});
