import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sinon from 'sinon';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';

import { HttpServer } from '../HttpServer.js';
import { RegistryService } from '../src/services/registryService.js';

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

  it('stops the registry watcher when start rejects on a bind failure', async () => {
    // A real filesystem registry starts a FileSystemRegistryWatcher during
    // initialize(); PartialRegistry starts none, so it cannot exercise this path.
    const registryDir = mkdtempSync(join(tmpdir(), 'hyp-registry-'));
    const registry = new FileSystemRegistry({ uri: registryDir });
    const blocker = await bindPort();
    const stopSpy = sinon.spy(RegistryService.prototype, 'stop');

    const httpServer = await HttpServer.create(async () => registry);

    try {
      await expect(httpServer.start(String(blocker.port))).to.be.rejected;
      // The watcher started during initialize() must be torn down so its active
      // handle cannot keep the event loop alive after the failed bind.
      expect(stopSpy.called).to.equal(true);
    } finally {
      stopSpy.restore();
      await blocker.close();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});
