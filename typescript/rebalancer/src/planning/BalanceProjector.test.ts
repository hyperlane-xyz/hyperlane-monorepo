import { expect } from 'chai';

import { BalanceProjector } from './BalanceProjector.js';

describe('BalanceProjector', () => {
  it('reserves destination collateral for pending transfers', () => {
    const balances = {
      ethereum: 100n,
      arbitrum: 50n,
    };

    const projected = BalanceProjector.reserveCollateral(balances, [
      { origin: 'ethereum', destination: 'arbitrum', amount: 70n },
    ]);

    expect(projected).to.deep.equal({
      ethereum: 100n,
      arbitrum: -20n,
    });
    expect(projected).to.not.equal(balances);
  });

  it('returns original balances when there is nothing to reserve', () => {
    const balances = { ethereum: 100n };

    expect(BalanceProjector.reserveCollateral(balances, [])).to.equal(balances);
  });

  it('simulates movable collateral pending rebalances by adding destination only', () => {
    const projected = BalanceProjector.simulatePendingRebalances(
      {
        ethereum: 100n,
        arbitrum: 50n,
      },
      [{ origin: 'ethereum', destination: 'arbitrum', amount: 25n }],
    );

    expect(projected).to.deep.equal({
      ethereum: 100n,
      arbitrum: 75n,
    });
  });

  it('simulates inventory pending rebalances using delivered and awaiting amounts', () => {
    const projected = BalanceProjector.simulatePendingRebalances(
      {
        ethereum: 100n,
        arbitrum: 50n,
      },
      [
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 80n,
          executionMethod: 'inventory',
          deliveredAmount: 30n,
          awaitingDeliveryAmount: 20n,
        },
      ],
    );

    expect(projected).to.deep.equal({
      ethereum: 50n,
      arbitrum: 80n,
    });
  });

  it('does not adjust inventory destination when delivery and awaiting amounts cover the route', () => {
    const projected = BalanceProjector.simulatePendingRebalances(
      {
        ethereum: 100n,
        arbitrum: 50n,
      },
      [
        {
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: 80n,
          executionMethod: 'inventory',
          deliveredAmount: 30n,
          awaitingDeliveryAmount: 50n,
        },
      ],
    );

    expect(projected).to.deep.equal({
      ethereum: 50n,
      arbitrum: 50n,
    });
  });

  it('simulates proposed rebalances on origin and destination', () => {
    const projected = BalanceProjector.simulateProposedRebalances(
      {
        ethereum: 100n,
        arbitrum: 50n,
      },
      [{ origin: 'ethereum', destination: 'arbitrum', amount: 25n }],
    );

    expect(projected).to.deep.equal({
      ethereum: 75n,
      arbitrum: 75n,
    });
  });
});
