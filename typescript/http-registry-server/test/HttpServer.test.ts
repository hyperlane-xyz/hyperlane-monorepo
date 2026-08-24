import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sinon from 'sinon';
import request from 'supertest';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';

import { HttpServer, parseCorsAllowedOrigins } from '../HttpServer.js';
import { RegistryService } from '../src/services/registryService.js';

chaiUse(chaiAsPromised);

describe('HttpServer CORS', () => {
  it('parses the comma-separated origin allowlist', () => {
    expect(
      parseCorsAllowedOrigins(
        'http://localhost:3000, https://bridge.example, ,*',
      ),
    ).to.deep.equal(['http://localhost:3000', 'https://bridge.example', '*']);
  });

  it('allows configured cross-origin reads without allowing other origins or writes', async () => {
    const httpServer = await HttpServer.create(
      async () => new PartialRegistry({}),
      { corsAllowedOrigins: ['http://localhost:3000'] },
    );

    const readResponse = await request(httpServer.app)
      .get('/anything')
      .set('Origin', 'http://localhost:3000');
    const headResponse = await request(httpServer.app)
      .head('/anything')
      .set('Origin', 'http://localhost:3000');
    const deniedResponse = await request(httpServer.app)
      .get('/anything')
      .set('Origin', 'https://malicious.example');
    const writeResponse = await request(httpServer.app)
      .post('/anything')
      .set('Origin', 'http://localhost:3000');

    expect(readResponse.headers['access-control-allow-origin']).to.equal(
      'http://localhost:3000',
    );
    expect(readResponse.headers.vary).to.equal('Origin');
    expect(headResponse.headers['access-control-allow-origin']).to.equal(
      'http://localhost:3000',
    );
    expect(headResponse.headers.vary).to.equal('Origin');
    expect(deniedResponse.headers['access-control-allow-origin']).to.be
      .undefined;
    expect(deniedResponse.headers.vary).to.equal('Origin');
    expect(writeResponse.headers['access-control-allow-origin']).to.be
      .undefined;
  });

  it('requires an explicit wildcard before allowing every browser origin', async () => {
    const defaultServer = await HttpServer.create(
      async () => new PartialRegistry({}),
      { corsAllowedOrigins: [] },
    );
    const publicServer = await HttpServer.create(
      async () => new PartialRegistry({}),
      { corsAllowedOrigins: ['*'] },
    );

    const deniedResponse = await request(defaultServer.app)
      .get('/anything')
      .set('Origin', 'https://example.com');
    const publicResponse = await request(publicServer.app)
      .get('/anything')
      .set('Origin', 'https://example.com');

    expect(deniedResponse.headers['access-control-allow-origin']).to.be
      .undefined;
    expect(publicResponse.headers['access-control-allow-origin']).to.equal('*');
    expect(publicResponse.headers.vary).to.equal('Origin');
  });
});

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
