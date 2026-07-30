import { expect } from 'chai';

import { withTimeout } from './multi-monitor.js';

describe('withTimeout', () => {
  it('rejects a never-settling promise after the timeout instead of hanging', async () => {
    // A registry read that never resolves models a hung getWarpRoute /
    // getWarpDeployConfig. Route resolution wraps each build in withTimeout so
    // this cannot block startup or the background retry that runs alongside
    // already-active route cycles.
    const neverSettles = new Promise<string>(() => {});

    let rejected: Error | undefined;
    try {
      await withTimeout(neverSettles, 20, 'Route resolution for MULTI/hung');
    } catch (error: unknown) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }

    expect(rejected).to.exist;
    expect(rejected!.message).to.equal(
      'Route resolution for MULTI/hung timed out after 20ms',
    );
  });

  it('returns the value when the promise settles before the timeout', async () => {
    const value = await withTimeout(
      Promise.resolve('ok'),
      1_000,
      'Route resolution for MULTI/fast',
    );
    expect(value).to.equal('ok');
  });
});
