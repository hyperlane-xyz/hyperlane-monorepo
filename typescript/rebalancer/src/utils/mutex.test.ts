import { expect } from 'chai';

import { Mutex } from './mutex.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('Mutex', () => {
  it('prevents concurrent critical sections from interleaving', async () => {
    const mutex = new Mutex();
    const entered = deferred();
    const release = deferred();
    let inside = false;

    const first = mutex.runExclusive(async () => {
      expect(inside).to.be.false;
      inside = true;
      entered.resolve();
      await release.promise;
      inside = false;
    });

    await entered.promise;
    const second = mutex.runExclusive(async () => {
      expect(inside).to.be.false;
      inside = true;
      inside = false;
    });

    await Promise.resolve();
    expect(inside).to.be.true;
    release.resolve();
    await Promise.all([first, second]);
  });

  it('runs waiters in FIFO order', async () => {
    const mutex = new Mutex();
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];

    const first = mutex.runExclusive(async () => {
      order.push('first:start');
      entered.resolve();
      await release.promise;
      order.push('first:end');
    });
    await entered.promise;

    const second = mutex.runExclusive(async () => {
      order.push('second');
    });
    const third = mutex.runExclusive(async () => {
      order.push('third');
    });

    release.resolve();
    await Promise.all([first, second, third]);

    expect(order).to.deep.equal([
      'first:start',
      'first:end',
      'second',
      'third',
    ]);
  });

  it('propagates rejection without poisoning the lock', async () => {
    const mutex = new Mutex();
    const expectedError = new Error('critical section failed');
    let caughtError: unknown;

    try {
      await mutex.runExclusive(async () => {
        throw expectedError;
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).to.equal(expectedError);
    expect(await mutex.runExclusive(async () => 'recovered')).to.equal(
      'recovered',
    );
  });

  it('propagates return values', async () => {
    const mutex = new Mutex();

    expect(await mutex.runExclusive(async () => 42)).to.equal(42);
  });
});
