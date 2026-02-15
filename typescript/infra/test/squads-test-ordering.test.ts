import { expect } from 'chai';

import { compareLexicographically } from './squads-test-ordering.js';

describe('squads test ordering helper', () => {
  it('returns zero for equal values', () => {
    expect(
      compareLexicographically(
        'scripts/squads/read-proposal.ts',
        'scripts/squads/read-proposal.ts',
      ),
    ).to.equal(0);
    expect(compareLexicographically('', '')).to.equal(0);
  });

  it('orders strings lexicographically in ascending order', () => {
    const unsortedPaths = [
      'scripts/squads/read-proposal.ts',
      'scripts/squads/get-pending-txs.ts',
      'scripts/squads/cancel-proposal.ts',
      'scripts/squads/parse-txs.ts',
    ];
    expect([...unsortedPaths].sort(compareLexicographically)).to.deep.equal([
      'scripts/squads/cancel-proposal.ts',
      'scripts/squads/get-pending-txs.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/read-proposal.ts',
    ]);
  });

  it('produces symmetric sign for non-equal values', () => {
    const left = 'scripts/squads/cancel-proposal.ts';
    const right = 'scripts/squads/read-proposal.ts';
    expect(compareLexicographically(left, right)).to.equal(-1);
    expect(compareLexicographically(right, left)).to.equal(1);
  });

  it('keeps duplicate values adjacent after sorting', () => {
    const unsortedPaths = [
      'scripts/squads/parse-txs.ts',
      'scripts/squads/read-proposal.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/cancel-proposal.ts',
    ];
    expect([...unsortedPaths].sort(compareLexicographically)).to.deep.equal([
      'scripts/squads/cancel-proposal.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/parse-txs.ts',
      'scripts/squads/read-proposal.ts',
    ]);
  });
});
