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
});
