import { expect } from 'chai';

import {
  ERC20_APPROVAL_INCREMENT_TOKENS,
  computeBufferedApprovalAmount,
} from './erc20Approval.js';

describe('computeBufferedApprovalAmount', () => {
  it('leaves an exact increment unchanged', () => {
    const exact = ERC20_APPROVAL_INCREMENT_TOKENS * 10n ** 18n;
    expect(computeBufferedApprovalAmount(exact, 18)).to.equal(exact);
  });

  it('rounds up to the next increment', () => {
    expect(computeBufferedApprovalAmount(750_000n * 10n ** 6n, 6)).to.equal(
      1_000_000n * 10n ** 6n,
    );
  });

  it('uses token decimals when computing the increment', () => {
    expect(computeBufferedApprovalAmount(1n, 6)).to.equal(
      ERC20_APPROVAL_INCREMENT_TOKENS * 10n ** 6n,
    );
    expect(computeBufferedApprovalAmount(1n, 18)).to.equal(
      ERC20_APPROVAL_INCREMENT_TOKENS * 10n ** 18n,
    );
  });

  it('rejects zero and negative required amounts', () => {
    expect(() => computeBufferedApprovalAmount(0n, 6)).to.throw(
      'Invalid required approval amount',
    );
    expect(() => computeBufferedApprovalAmount(-1n, 6)).to.throw(
      'Invalid required approval amount',
    );
  });
});
