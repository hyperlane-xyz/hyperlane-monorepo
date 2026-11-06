import { expect } from 'chai';

import { allocateRoutes } from './allocateRoutes.js';

describe('enabled-route allocation', () => {
  const surpluses = [
    { chain: 'A', amount: 2n },
    { chain: 'B', amount: 1n },
  ];
  const deficits = [
    { chain: 'C', amount: 2n },
    { chain: 'D', amount: 1n },
  ];

  it('reassigns an earlier transfer to unblock a donor with fewer exits', () => {
    const enabled = (origin: string, destination: string) =>
      !(origin === 'B' && destination === 'D');
    const result = allocateRoutes(surpluses, deficits, enabled);
    expect(result).to.deep.equal([
      { origin: 'A', destination: 'C', amount: 1n },
      { origin: 'A', destination: 'D', amount: 1n },
      { origin: 'B', destination: 'C', amount: 1n },
    ]);
    expect(allocateRoutes(surpluses, deficits, enabled)).to.deep.equal(result);
    expect(surpluses[0].amount).to.equal(2n);
    expect(deficits[0].amount).to.equal(2n);
  });

  it('allocates crossed routes without spending disabled-edge capacity', () => {
    expect(
      allocateRoutes(
        [
          { chain: 'A', amount: 100n },
          { chain: 'B', amount: 100n },
        ],
        [
          { chain: 'C', amount: 100n },
          { chain: 'D', amount: 100n },
        ],
        (origin, destination) =>
          origin === 'A' ? destination === 'D' : destination === 'C',
      ),
    ).to.deep.equal([
      { origin: 'A', destination: 'D', amount: 100n },
      { origin: 'B', destination: 'C', amount: 100n },
    ]);
  });

  it('keeps safe partial allocations when a recipient is disconnected', () => {
    const routes = allocateRoutes(
      surpluses,
      deficits,
      (_, destination) => destination === 'C',
    );
    expect(routes).to.deep.equal([
      { origin: 'A', destination: 'C', amount: 2n },
    ]);
    expect(allocateRoutes(surpluses, deficits, () => false)).to.deep.equal([]);
  });

  it('conserves amounts larger than Number.MAX_SAFE_INTEGER', () => {
    const amount = 10n ** 30n;
    const routes = allocateRoutes(
      [{ chain: 'A', amount }],
      [{ chain: 'B', amount: amount + 1n }],
      () => true,
    );
    expect(routes).to.deep.equal([{ origin: 'A', destination: 'B', amount }]);
  });
});
