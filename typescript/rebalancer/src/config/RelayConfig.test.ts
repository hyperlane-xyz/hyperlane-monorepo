import { expect } from 'chai';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerConfigSchema,
  RebalancerStrategyOptions,
  RelayBridgeConfigSchema,
} from './types.js';

describe('Relay configuration', () => {
  const config = {
    warpRouteId: 'USDC/test',
    inventorySigners: {
      ethereum: '0x1111111111111111111111111111111111111111',
    },
    strategy: {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        base: {
          weighted: { weight: 1, tolerance: 1 },
          executionType: ExecutionType.Inventory,
          externalBridge: ExternalBridgeType.Relay,
        },
      },
    },
  };

  it('defaults to 0.1% slippage and a 1% total loss ceiling', () => {
    expect(RelayBridgeConfigSchema.parse({})).to.deep.equal({
      defaultSlippage: 0.001,
      maxQuoteLossBps: 100,
    });
    expect(
      RebalancerConfigSchema.parse({
        ...config,
        externalBridges: { relay: {} },
      }).externalBridges?.relay,
    ).to.deep.equal({ defaultSlippage: 0.001, maxQuoteLossBps: 100 });
  });

  it('requires configured Relay settings when selected', () => {
    expect(() => RebalancerConfigSchema.parse(config)).to.throw(
      'externalBridges.relay is not configured',
    );
  });

  it('rejects misspelled settings and invalid loss budgets', () => {
    expect(
      RelayBridgeConfigSchema.safeParse({ maxQuoteLossBPs: 100 }).success,
    ).to.equal(false);
    for (const maxQuoteLossBps of [-1, 10001, 0.5]) {
      expect(
        RelayBridgeConfigSchema.safeParse({ maxQuoteLossBps }).success,
      ).to.equal(false);
    }
  });
});
