import { expect } from 'chai';

import { allocateSequentialPorts, waitUntilReady } from './helpers.js';

describe('allocateSequentialPorts', () => {
  it('returns a contiguous block starting at basePort', () => {
    expect(allocateSequentialPorts(8545, 3)).to.deep.equal([8545, 8546, 8547]);
  });

  it('returns an empty array for a zero count', () => {
    expect(allocateSequentialPorts(8545, 0)).to.deep.equal([]);
  });

  it('throws for a negative count', () => {
    expect(() => allocateSequentialPorts(8545, -1)).to.throw(
      'Port count must be non-negative',
    );
  });

  it('throws for an out-of-range base port', () => {
    expect(() => allocateSequentialPorts(0, 1)).to.throw('Base port');
  });

  it('throws when the range overflows the max port', () => {
    expect(() => allocateSequentialPorts(65535, 2)).to.throw(
      'exceeds max port',
    );
  });
});

describe('waitUntilReady', () => {
  it('resolves once the probe succeeds after transient failures', async () => {
    let calls = 0;
    await waitUntilReady(
      () => {
        calls++;
        if (calls < 3) {
          return Promise.reject(new Error('not ready'));
        }
        return Promise.resolve('ready');
      },
      { attempts: 5, baseRetryMs: 1 },
    );
    expect(calls).to.equal(3);
  });

  it('rejects after attempts are exhausted', async () => {
    let calls = 0;
    let threw = false;
    try {
      await waitUntilReady(
        () => {
          calls++;
          return Promise.reject(new Error('never ready'));
        },
        { attempts: 3, baseRetryMs: 1 },
      );
    } catch (error: unknown) {
      threw = true;
      expect(error).to.be.instanceOf(Error);
    }
    expect(threw).to.equal(true);
    expect(calls).to.equal(3);
  });

  it('stops probing and rejects once its signal is aborted mid-retry', async () => {
    const baseRetryMs = 1000;
    const controller = new AbortController();
    let calls = 0;
    const pending = waitUntilReady(
      () => {
        calls++;
        return Promise.reject(new Error('not ready'));
      },
      { attempts: 60, baseRetryMs, signal: controller.signal },
    );

    // Let the first probe run and enter its inter-attempt sleep, then abort.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const callsAtAbort = calls;
    const abortedAt = Date.now();
    controller.abort();

    let rejected = false;
    try {
      await pending;
    } catch {
      rejected = true;
    }
    const rejectedAfterMs = Date.now() - abortedAt;

    expect(rejected).to.equal(true);
    // No further probe fired after the abort.
    expect(calls).to.equal(callsAtAbort);
    // Rejection landed far under baseRetryMs, proving the pending timer was
    // cancelled on abort rather than run to completion.
    expect(rejectedAfterMs).to.be.lessThan(200);
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    let calls = 0;
    let rejected = false;
    try {
      await waitUntilReady(
        () => {
          calls++;
          return Promise.resolve('ready');
        },
        { attempts: 5, baseRetryMs: 1, signal: AbortSignal.abort() },
      );
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    expect(calls).to.equal(0);
  });

  it('waits a bounded, linear time rather than backing off exponentially', async () => {
    const attempts = 10;
    const baseRetryMs = 2;
    let calls = 0;
    let threw = false;

    const start = Date.now();
    try {
      await waitUntilReady(
        () => {
          calls++;
          return Promise.reject(new Error('never ready'));
        },
        { attempts, baseRetryMs },
      );
    } catch (error: unknown) {
      threw = true;
      expect(error).to.be.instanceOf(Error);
    }
    const elapsed = Date.now() - start;

    expect(threw).to.equal(true);
    expect(calls).to.equal(attempts);
    // Linear timing is ~(attempts - 1) * baseRetryMs (~18ms); exponential backoff
    // would be baseRetryMs * (2 ** attempts - 1) (~2s). Well under that bound.
    expect(elapsed).to.be.lessThan(300);
  });
});
