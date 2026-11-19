import { expect } from 'chai';

import { maximumInputForLoss, minimumOutputForLoss } from './quoteBudget.js';

describe('minimumOutputForLoss', () => {
  it('uses destination units and rounds upward to preserve the loss budget', () => {
    expect(
      minimumOutputForLoss(1_000_000_000_000_000_000n, 18, 6, 50),
    ).to.equal(995_000n);
    expect(minimumOutputForLoss(101n, 6, 6, 50)).to.equal(101n);
    expect(minimumOutputForLoss(1n, 6, 18, 0)).to.equal(1_000_000_000_000n);
    expect(minimumOutputForLoss(1n, 6, 6, 10_000)).to.equal(0n);
  });

  it('rejects invalid arithmetic inputs', () => {
    expect(() => minimumOutputForLoss(0n, 6, 6, 50)).to.throw('positive');
    expect(() => minimumOutputForLoss(1n, -1, 6, 50)).to.throw('decimals');
    expect(() => minimumOutputForLoss(1n, 6, 256, 50)).to.throw('decimals');
    expect(() => minimumOutputForLoss(1n, 6, 6, 0.5)).to.throw('loss');
  });
});

describe('maximumInputForLoss', () => {
  it('rounds down and handles differing token decimals', () => {
    expect(maximumInputForLoss(9_970_000n, 6, 6, 100)).to.equal(10_070_707n);
    expect(maximumInputForLoss(1_000_000n, 18, 6, 0)).to.equal(
      1_000_000_000_000_000_000n,
    );
    expect(maximumInputForLoss(101n, 6, 6, 50)).to.equal(101n);
  });
  it('rejects an unbounded budget and invalid amounts', () => {
    expect(() => maximumInputForLoss(1n, 6, 6, 10000)).to.throw('finite');
    expect(() => maximumInputForLoss(0n, 6, 6, 100)).to.throw('positive');
  });
});
