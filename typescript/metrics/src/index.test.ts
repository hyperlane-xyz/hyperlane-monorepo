import { expect } from 'chai';
import { Registry } from 'prom-client';

import { createWarpMetricsGauges } from './gauges.js';

describe('Warp Metrics', () => {
  describe('createWarpMetricsGauges', () => {
    it('should create all required gauges', () => {
      const registry = new Registry();
      const gauges = createWarpMetricsGauges(registry);

      expect(gauges).to.have.property('warpRouteTokenBalance');
      expect(gauges).to.have.property('warpRouteCollateralValue');
      expect(gauges).to.have.property('warpRouteValueAtRisk');
      expect(gauges).to.have.property('walletBalanceGauge');
      expect(gauges).to.have.property('xERC20LimitsGauge');
    });

    it('should register gauges with the provided registry', async () => {
      const registry = new Registry();
      createWarpMetricsGauges(registry);

      const metrics = await registry.metrics();
      expect(metrics).to.include('hyperlane_warp_route_token_balance');
      expect(metrics).to.include('hyperlane_warp_route_collateral_value');
      expect(metrics).to.include('hyperlane_warp_route_value_at_risk');
      expect(metrics).to.include('hyperlane_wallet_balance');
      expect(metrics).to.include('hyperlane_xerc20_limits');
    });

    it('should support additional wallet balance labels', async () => {
      const registry = new Registry();
      const gauges = createWarpMetricsGauges(registry, ['warp_route_id']);

      // Set a value to verify the label is accepted
      gauges.walletBalanceGauge
        .labels({
          chain: 'ethereum',
          wallet_address: '0x123',
          wallet_name: 'test',
          token_address: 'native',
          token_symbol: 'ETH',
          token_name: 'Ether',
          warp_route_id: 'test-route',
        })
        .set(1.5);

      const metrics = await registry.metrics();
      expect(metrics).to.include('warp_route_id="test-route"');
    });
  });
});
