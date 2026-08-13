import { expect } from 'chai';
import { createServer } from 'node:net';

import {
  type AnvilProcessHandle,
  EvmForkManager,
  type WaitForEvmRpcReady,
} from './EvmForkManager.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('expected a bound TCP address');
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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

describe('EvmForkManager readiness abort', () => {
  it('aborts the readiness probe when anvil exits before its RPC is ready', async () => {
    let capturedSignal: AbortSignal | undefined;
    const capturingNeverReady: WaitForEvmRpcReady = (_provider, signal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {});
    };

    // A fake anvil that "exits" immediately drives the exit branch of the race
    // without a live process; the readiness probe above never settles on its
    // own, so only the abort can stop it.
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(Promise.resolve(), { kill: () => {} });

    const manager = new EvmForkManager(
      {
        chainName: 'anvil2',
        chainId: 31337,
        upstreamRpcUrl: 'http://127.0.0.1:1',
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: capturingNeverReady },
    );

    let rejected = false;
    try {
      await manager.start();
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);
    // Without the abort the never-settling probe's retry timers would keep
    // polling a dead port after anvil already exited.
    expect(capturedSignal?.aborted).to.equal(true);
  });
});
