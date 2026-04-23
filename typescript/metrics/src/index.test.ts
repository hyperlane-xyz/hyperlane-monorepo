import { Registry } from 'prom-client';
import { expect } from 'vitest';

import { createWarpMetricsGauges } from './gauges.js';

describe('Warp Metrics', () => {
  describe('createWarpMetricsGauges', () => {
    it('should create all required gauges', () => {
      const registry = new Registry();
      const gauges = createWarpMetricsGauges(registry);

      expect(gauges).toHaveProperty('warpRouteTokenBalance');
      expect(gauges).toHaveProperty('warpRouteCollateralValue');
      expect(gauges).toHaveProperty('warpRouteValueAtRisk');
      expect(gauges).toHaveProperty('walletBalanceGauge');
      expect(gauges).toHaveProperty('xERC20LimitsGauge');
    });

    it('should register gauges with the provided registry', async () => {
      const registry = new Registry();
      createWarpMetricsGauges(registry);

      const metrics = await registry.metrics();
      expect(metrics).toContain('hyperlane_warp_route_token_balance');
      expect(metrics).toContain('hyperlane_warp_route_collateral_value');
      expect(metrics).toContain('hyperlane_warp_route_value_at_risk');
      expect(metrics).toContain('hyperlane_wallet_balance');
      expect(metrics).toContain('hyperlane_xerc20_limits');
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
      expect(metrics).toContain('warp_route_id="test-route"');
    });
  });
});
