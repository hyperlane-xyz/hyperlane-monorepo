import { expect } from 'vitest';

import { LazyAsync } from './async.js';

describe('LazyAsync', () => {
  it('initializes on first get', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 5;
    });

    expect(lazy.isInitialized()).toBe(false);
    expect(lazy.peek()).toBe(undefined);

    const value = await lazy.get();
    expect(value).toBe(5);
    expect(calls).toBe(1);
    expect(lazy.isInitialized()).toBe(true);
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

    expect(p1).toBe(p2);
    expect(calls).toBe(1);

    resolve(7);
    const value = await p1;
    expect(value).toBe(7);
  });

  it('returns cached value on subsequent calls', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 3;
    });

    const v1 = await lazy.get();
    const v2 = await lazy.get();

    expect(v1).toBe(3);
    expect(v2).toBe(3);
    expect(calls).toBe(1);
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

    expect(err?.message).toBe('boom');

    const value = await lazy.get();
    expect(value).toBe(9);
    expect(calls).toBe(2);
  });

  it('reset clears and allows re-init', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return calls;
    });

    const v1 = await lazy.get();
    expect(v1).toBe(1);

    lazy.reset();
    expect(lazy.isInitialized()).toBe(false);
    expect(lazy.peek()).toBe(undefined);

    const v2 = await lazy.get();
    expect(v2).toBe(2);
    expect(calls).toBe(2);
  });

  it('peek does not trigger init', async () => {
    let calls = 0;
    const lazy = new LazyAsync(async () => {
      calls += 1;
      return 4;
    });

    expect(lazy.peek()).toBe(undefined);
    expect(calls).toBe(0);

    await lazy.get();
    expect(lazy.peek()).toBe(4);
    expect(calls).toBe(1);
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
    expect(calls).toBe(1);

    // Reset while first init is in-flight
    lazy.reset();
    expect(lazy.isInitialized()).toBe(false);

    // Start second initialization (should create new promise)
    const originalResolve = resolve;
    const p2 = lazy.get();
    const resolve2 = resolve;
    expect(calls).toBe(2);
    expect(p1).not.toBe(p2);

    // Complete second init first
    resolve2(200);
    const v2 = await p2;
    expect(v2).toBe(200);
    expect(lazy.isInitialized()).toBe(true);
    expect(lazy.peek()).toBe(200);

    // Complete first init (stale) - should NOT overwrite cache
    originalResolve(100);
    const v1 = await p1;
    expect(v1).toBe(100); // Promise still resolves with its value

    // But cache should still have second value
    expect(lazy.peek()).toBe(200);
    expect(lazy.isInitialized()).toBe(true);
  });
});
