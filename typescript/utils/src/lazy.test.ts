import { expect } from 'chai';

import { LazyAsync } from './async.js';

describe('LazyAsync', () => {
  it('initializes on first get', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 5;
    });

    expect(lazy.isInitialized()).to.equal(false);
    expect(lazy.peek()).to.equal(undefined);

    const value = await lazy.get();
    expect(value).to.equal(5);
    expect(calls).to.equal(1);
    expect(lazy.isInitialized()).to.equal(true);
  });

  it('dedupes concurrent calls', async () => {
    let calls = 0;
    let resolve!: (value: number) => void;

    const lazy = new LazyAsync(() => {
      calls += 1;
      return new Promise<number>((res) => {
        resolve = res;
      });
    });

    const p1 = lazy.get();
    const p2 = lazy.get();

    expect(p1).to.equal(p2);
    expect(calls).to.equal(1);

    resolve(7);
    const value = await p1;
    expect(value).to.equal(7);
  });

  it('returns cached value on subsequent calls', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 3;
    });

    const v1 = await lazy.get();
    const v2 = await lazy.get();

    expect(v1).to.equal(3);
    expect(v2).to.equal(3);
    expect(calls).to.equal(1);
  });

  it('retries after error by default', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 9;
    });

    let err: Error | undefined;
    try {
      await lazy.get();
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).to.equal('boom');

    const value = await lazy.get();
    expect(value).to.equal(9);
    expect(calls).to.equal(2);
  });

  it('reset clears and allows re-init', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return calls;
    });

    const v1 = await lazy.get();
    expect(v1).to.equal(1);

    lazy.reset();
    expect(lazy.isInitialized()).to.equal(false);
    expect(lazy.peek()).to.equal(undefined);

    const v2 = await lazy.get();
    expect(v2).to.equal(2);
    expect(calls).to.equal(2);
  });

  it('peek does not trigger init', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 4;
    });

    expect(lazy.peek()).to.equal(undefined);
    expect(calls).to.equal(0);

    await lazy.get();
    expect(lazy.peek()).to.equal(4);
    expect(calls).to.equal(1);
  });

  it('reset during in-flight init does not repopulate cache', async () => {
    let calls = 0;
    let resolve!: (value: number) => void;

    const lazy = new LazyAsync(() => {
      calls += 1;
      return new Promise<number>((res) => {
        resolve = res;
      });
    });

    // Start first initialization
    const p1 = lazy.get();
    expect(calls).to.equal(1);

    // Reset while first init is in-flight
    lazy.reset();
    expect(lazy.isInitialized()).to.equal(false);

    // Start second initialization (should create new promise)
    const originalResolve = resolve;
    const p2 = lazy.get();
    const resolve2 = resolve;
    expect(calls).to.equal(2);
    expect(p1).to.not.equal(p2);

    // Complete second init first
    resolve2(200);
    const v2 = await p2;
    expect(v2).to.equal(200);
    expect(lazy.isInitialized()).to.equal(true);
    expect(lazy.peek()).to.equal(200);

    // Complete first init (stale) - should NOT overwrite cache
    originalResolve(100);
    const v1 = await p1;
    expect(v1).to.equal(100); // Promise still resolves with its value

    // But cache should still have second value
    expect(lazy.peek()).to.equal(200);
    expect(lazy.isInitialized()).to.equal(true);
  });
});

describe('LazyAsync synchronous failure recovery', () => {
  it('shares a synchronous failure and retries initialization on the next get', async () => {
    let calls = 0;
    const failure = new Error(
      'Initialization failed before returning a promise',
    );
    const lazy = new LazyAsync(() => {
      if (++calls === 1) throw failure;
      return Promise.resolve(42);
    });

    const first = lazy.get();
    const second = lazy.get();
    expect(first).to.equal(second);
    const outcomes = await Promise.allSettled([first, second]);
    for (const outcome of outcomes) {
      expect(outcome.status).to.equal('rejected');
      if (outcome.status === 'rejected')
        expect(outcome.reason).to.equal(failure);
    }
    expect(lazy.isInitialized()).to.equal(false);
    expect(lazy.peek()).to.equal(undefined);
    expect(await lazy.get()).to.equal(42);
    expect(calls).to.equal(2);
    expect(lazy.peek()).to.equal(42);
  });

  it('does not clear a newer initialization when a stale synchronous failure settles', async () => {
    let calls = 0;
    const lazy = new LazyAsync(() => {
      if (++calls === 1) throw new Error('Stale failure');
      return Promise.resolve(42);
    });
    const stale = lazy.get();
    lazy.reset();
    const current = lazy.get();
    await Promise.allSettled([stale]);
    expect(await current).to.equal(42);
    expect(lazy.peek()).to.equal(42);
    expect(calls).to.equal(2);
  });
});
