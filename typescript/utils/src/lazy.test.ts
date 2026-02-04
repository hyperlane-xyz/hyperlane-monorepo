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
});
