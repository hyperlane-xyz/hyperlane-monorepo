import { expect } from 'chai';
import { createServer } from 'node:net';

import { EvmForkManager } from './EvmForkManager.js';

describe('EvmForkManager port preflight', () => {
  it('start() rejects before spawning when the port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    expect(address).to.be.an('object');
    if (!address || typeof address !== 'object') {
      throw new Error('expected a bound TCP address');
    }
    const port = address.port;

    const manager = new EvmForkManager({
      chainName: 'anvil2',
      chainId: 31337,
      // Unreachable upstream: the preflight must fail before anvil is spawned,
      // so this is never dialed.
      upstreamRpcUrl: 'http://127.0.0.1:1',
      port,
    });

    let rejected: unknown;
    try {
      await manager.start();
    } catch (error: unknown) {
      rejected = error;
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    expect(rejected).to.be.instanceOf(Error);
    if (rejected instanceof Error) {
      expect(rejected.message).to.include(`port ${port} is already in use`);
    }
  });
});
