import { expect } from 'chai';

import { LocalInventoryView } from './InventoryView.js';

describe('LocalInventoryView', () => {
  let view: LocalInventoryView;

  beforeEach(() => {
    view = new LocalInventoryView();
  });

  it('defaults unknown balances to zero', () => {
    expect(view.getBalance('unknown')).to.equal(0n);
  });

  it('replaces balances instead of merging them', () => {
    view.setBalances({ ethereum: 10n, arbitrum: 20n });
    view.setBalances({ ethereum: 30n });

    expect(view.getBalance('ethereum')).to.equal(30n);
    expect(view.getBalance('arbitrum')).to.equal(0n);
  });

  it('sums balances and excludes specified chains', () => {
    view.setBalances({ ethereum: 10n, arbitrum: 20n, optimism: 30n });

    expect(view.getTotal([])).to.equal(60n);
    expect(view.getTotal(['arbitrum', 'optimism'])).to.equal(10n);
  });

  it('accumulates consumption', () => {
    view.consume('ethereum', 3n);
    view.consume('ethereum', 4n);

    expect(view.getConsumed('ethereum')).to.equal(7n);
    expect(view.getConsumed('arbitrum')).to.equal(0n);
  });

  it('clamps effective balances to zero', () => {
    view.setBalances({ ethereum: 10n });
    view.consume('ethereum', 11n);

    expect(view.getEffectiveBalance('ethereum')).to.equal(0n);
  });

  it('clears consumption without clearing balances at cycle start', () => {
    view.setBalances({ ethereum: 10n });
    view.consume('ethereum', 4n);

    view.beginCycle();

    expect(view.getBalance('ethereum')).to.equal(10n);
    expect(view.getConsumed('ethereum')).to.equal(0n);
    expect(view.getEffectiveBalance('ethereum')).to.equal(10n);
  });

  it('returns raw balance entries', () => {
    view.setBalances({ ethereum: 10n, arbitrum: 20n });
    view.consume('ethereum', 4n);

    expect(Array.from(view.entries())).to.deep.equal([
      ['ethereum', 10n],
      ['arbitrum', 20n],
    ]);
  });
});
