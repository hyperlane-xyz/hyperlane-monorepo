import { expect } from 'chai';

import {
  concurrentMap,
  fetchWithTimeout,
  mapAllSettled,
  pollAsync,
  raceWithContext,
  retryAsync,
  runWithTimeout,
  sleep,
  timeout,
} from './async.js';

describe('Async Utilities', () => {
  describe('sleep', () => {
    it('should resolve after sleep duration', async () => {
      const start = Date.now();
      await sleep(100);
      const duration = Date.now() - start;
      expect(duration).to.be.at.least(95);
      expect(duration).to.be.lessThan(200);
    });
  });

  describe('timeout', () => {
    it('should timeout a promise', async () => {
      const promise = new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await timeout(promise, 100);
        throw new Error('Expected timeout error');
      } catch (error: any) {
        expect(error.message).to.equal('Timeout reached');
      }
    });
  });

  describe('runWithTimeout', () => {
    it('should run a callback with a timeout', async () => {
      const result = await runWithTimeout(100, async () => {
        await sleep(50);
        return 'success';
      });
      expect(result).to.equal('success');
    });
  });

  describe('fetchWithTimeout', () => {
    it('should fetch with timeout', async () => {
      // Mock fetch for testing
      global.fetch = async () => {
        await sleep(50);
        return new Response('ok');
      };

      const response = await fetchWithTimeout('https://example.com', {}, 100);
      expect(await response.text()).to.equal('ok');
    });
  });

  describe('retryAsync', () => {
    it('should retry until success', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'success';
      };

      const result = await retryAsync(runner, 5, 10);
      expect(result).to.equal('success');
    });

    it('should retry `attempts` times at most', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        throw new Error('fail');
      };

      try {
        await retryAsync(runner, 5, 10);
        throw new Error('Expected error to be thrown');
      } catch (error: any) {
        expect(error.message).to.equal('fail');
        expect(attempt).to.equal(5);
      }
    });

    it('should immediately throw error if isRecoverable is false', async () => {
      let attempts = 0;
      const runner = async () => {
        attempts++;
        const error = new Error('non-recoverable error') as Error & {
          isRecoverable?: boolean;
        };
        error.isRecoverable = false;
        throw error;
      };

      try {
        await retryAsync(runner, 5, 10);
        throw new Error('Expected error to be thrown');
      } catch (error: any) {
        expect(error.message).to.equal('non-recoverable error');
        expect(error.isRecoverable).to.equal(false);
        expect(attempts).to.equal(1);
      }
    });

    it('should continue retrying if isRecoverable is not set', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        if (attempt < 3) throw new Error('recoverable error');
        return 'success';
      };

      const result = await retryAsync(runner, 5, 10);
      expect(result).to.equal('success');
      expect(attempt).to.equal(3);
    });

    it('should continue retrying if isRecoverable is true', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        if (attempt < 3) {
          const error = new Error('recoverable error') as Error & {
            isRecoverable?: boolean;
          };
          error.isRecoverable = true;
          throw error;
        }
        return 'success';
      };

      const result = await retryAsync(runner, 5, 10);
      expect(result).to.equal('success');
      expect(attempt).to.equal(3);
    });

    it('should execute at least once even with 0 attempts', async () => {
      let attempts = 0;
      const runner = async () => {
        attempts++;
        return 'success';
      };

      const result = await retryAsync(runner, 0, 10);
      expect(result).to.equal('success');
      expect(attempts).to.equal(1);
    });

    it('should execute at least once even with negative attempts', async () => {
      let attempts = 0;
      const runner = async () => {
        attempts++;
        return 'success';
      };

      const result = await retryAsync(runner, -5, 10);
      expect(result).to.equal('success');
      expect(attempts).to.equal(1);
    });
  });

  describe('pollAsync', () => {
    it('should poll async function until success', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'success';
      };

      const result = await pollAsync(runner, 10, 5);
      expect(result).to.equal('success');
    });

    it('should fail after reaching max retries', async () => {
      let attempt = 0;
      const runner = async () => {
        attempt++;
        throw new Error('fail');
      };

      try {
        await pollAsync(runner, 10, 3); // Set maxAttempts to 3
        throw new Error('Expected pollAsync to throw an error');
      } catch (error: any) {
        expect(attempt).to.equal(3); // Ensure it attempted 3 times
        expect(error.message).to.equal('fail');
      }
    });
  });

  describe('raceWithContext', () => {
    it('should race with context', async () => {
      const promises = [
        sleep(50).then(() => 'first'),
        sleep(100).then(() => 'second'),
      ];

      const result = await raceWithContext(promises);
      expect(result.resolved).to.equal('first');
      expect(result.index).to.equal(0);
    });
  });

  describe('concurrentMap', () => {
    it('should map concurrently with correct results', async () => {
      const xs = [1, 2, 3, 4, 5, 6];
      const mapFn = async (val: number) => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // Simulate async work
        return val * 2;
      };
      const result = await concurrentMap(2, xs, mapFn);
      expect(result).to.deep.equal([2, 4, 6, 8, 10, 12]);
    });

    it('should respect concurrency limit', async () => {
      const xs = [1, 2, 3, 4, 5, 6];
      const concurrency = 2;
      let activeTasks = 0;
      let maxActiveTasks = 0;

      const mapFn = async (val: number) => {
        activeTasks++;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        await new Promise((resolve) => setTimeout(resolve, 50)); // Simulate async work
        activeTasks--;
        return val * 2;
      };

      await concurrentMap(concurrency, xs, mapFn);
      expect(maxActiveTasks).to.equal(concurrency);
    });
  });
});

describe('mapAllSettled', () => {
  it('should return all fulfilled results when all promises succeed', async () => {
    const items = ['a', 'b', 'c'];
    const { fulfilled, rejected } = await mapAllSettled(
      items,
      async (item) => item.toUpperCase(),
      (item) => item,
    );

    expect(fulfilled.size).to.equal(3);
    expect(fulfilled.get('a')).to.equal('A');
    expect(fulfilled.get('b')).to.equal('B');
    expect(fulfilled.get('c')).to.equal('C');
    expect(rejected.size).to.equal(0);
  });

  it('should return all rejected results when all promises fail', async () => {
    const items = ['a', 'b', 'c'];
    const { fulfilled, rejected } = await mapAllSettled(
      items,
      async (item) => {
        throw new Error(`Failed: ${item}`);
      },
      (item) => item,
    );

    expect(fulfilled.size).to.equal(0);
    expect(rejected.size).to.equal(3);
    expect(rejected.get('a')?.message).to.equal('Failed: a');
    expect(rejected.get('b')?.message).to.equal('Failed: b');
    expect(rejected.get('c')?.message).to.equal('Failed: c');
  });

  it('should handle mixed success and failure', async () => {
    const items = [1, 2, 3, 4, 5];
    const { fulfilled, rejected } = await mapAllSettled(
      items,
      async (item) => {
        if (item % 2 === 0) {
          throw new Error(`Even number: ${item}`);
        }
        return item * 10;
      },
      (item) => item,
    );

    expect(fulfilled.size).to.equal(3);
    expect(fulfilled.get(1)).to.equal(10);
    expect(fulfilled.get(3)).to.equal(30);
    expect(fulfilled.get(5)).to.equal(50);

    expect(rejected.size).to.equal(2);
    expect(rejected.get(2)?.message).to.equal('Even number: 2');
    expect(rejected.get(4)?.message).to.equal('Even number: 4');
  });

  it('should use index as key when keyFn is not provided', async () => {
    const items = ['a', 'b', 'c'];
    const { fulfilled, rejected } = await mapAllSettled(items, async (item) =>
      item.toUpperCase(),
    );

    expect(fulfilled.size).to.equal(3);
    expect(fulfilled.get(0)).to.equal('A');
    expect(fulfilled.get(1)).to.equal('B');
    expect(fulfilled.get(2)).to.equal('C');
    expect(rejected.size).to.equal(0);
  });

  it('should convert non-Error rejection reasons to Error objects', async () => {
    const items = ['a'];
    const { rejected } = await mapAllSettled(
      items,
      async () => {
        throw 'string error';
      },
      (item) => item,
    );

    expect(rejected.size).to.equal(1);
    expect(rejected.get('a')).to.be.instanceOf(Error);
    expect(rejected.get('a')?.message).to.equal('string error');
  });

  it('should handle empty array', async () => {
    const items: string[] = [];
    const { fulfilled, rejected } = await mapAllSettled(
      items,
      async (item) => item.toUpperCase(),
      (item) => item,
    );

    expect(fulfilled.size).to.equal(0);
    expect(rejected.size).to.equal(0);
  });

  it('should pass index to mapFn', async () => {
    const items = ['a', 'b', 'c'];
    const { fulfilled } = await mapAllSettled(
      items,
      async (item, index) => `${item}-${index}`,
      (item) => item,
    );

    expect(fulfilled.get('a')).to.equal('a-0');
    expect(fulfilled.get('b')).to.equal('b-1');
    expect(fulfilled.get('c')).to.equal('c-2');
  });

  it('should pass index to keyFn', async () => {
    const items = ['a', 'b', 'c'];
    const { fulfilled } = await mapAllSettled(
      items,
      async (item) => item.toUpperCase(),
      (_item, index) => `key-${index}`,
    );

    expect(fulfilled.get('key-0')).to.equal('A');
    expect(fulfilled.get('key-1')).to.equal('B');
    expect(fulfilled.get('key-2')).to.equal('C');
  });

  it('should process items in parallel', async () => {
    const items = [1, 2, 3];
    const startTime = Date.now();

    await mapAllSettled(
      items,
      async () => {
        await sleep(50);
        return 'done';
      },
      (item) => item,
    );

    const duration = Date.now() - startTime;
    // If run in parallel, should take ~50ms, not ~150ms
    expect(duration).to.be.lessThan(100);
  });
});
