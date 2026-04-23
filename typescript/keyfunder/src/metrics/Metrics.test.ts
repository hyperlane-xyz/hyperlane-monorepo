import { expect } from 'vitest';

import { KeyFunderMetrics } from './Metrics.js';

describe('KeyFunderMetrics', () => {
  describe('constructor', () => {
    it('should create metrics without push gateway', () => {
      const metrics = new KeyFunderMetrics(undefined);
      expect(metrics.getRegistry()).toBeDefined();
    });

    it('should create metrics with config', () => {
      const metrics = new KeyFunderMetrics({
        jobName: 'test',
      });
      expect(metrics.getRegistry()).toBeDefined();
    });

    it('should include base labels in gauge configurations', () => {
      const metrics = new KeyFunderMetrics(
        { jobName: 'test' },
        { environment: 'testnet' },
      );
      expect(metrics.getRegistry()).toBeDefined();
    });
  });

  describe('recordWalletBalance', () => {
    it('should record wallet balance metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordWalletBalance(
        'ethereum',
        '0x1234567890123456789012345678901234567890',
        'relayer',
        1.5,
      );

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_keyfunder_wallet_balance');
      expect(metricsOutput).toContain('ethereum');
      expect(metricsOutput).toContain('relayer');
    });
  });

  describe('recordUnifiedWalletBalance', () => {
    it('should record unified wallet balance metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordUnifiedWalletBalance(
        'ethereum',
        '0x1234567890123456789012345678901234567890',
        'key-funder',
        1.5,
      );

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_wallet_balance');
      expect(metricsOutput).toContain('wallet_name="key-funder"');
      expect(metricsOutput).toContain('token_address="native"');
      expect(metricsOutput).toContain('token_symbol="Native"');
      expect(metricsOutput).toContain('token_name="Native"');
      expect(metricsOutput).toContain('ethereum');
    });
  });

  describe('recordFundingAmount', () => {
    it('should record funding amount metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordFundingAmount(
        'arbitrum',
        '0x1234567890123456789012345678901234567890',
        'kathy',
        0.25,
      );

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_keyfunder_funding_amount');
      expect(metricsOutput).toContain('arbitrum');
      expect(metricsOutput).toContain('kathy');
    });
  });

  describe('recordIgpBalance', () => {
    it('should record IGP balance metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordIgpBalance('polygon', 2.5);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_keyfunder_igp_balance');
      expect(metricsOutput).toContain('polygon');
    });
  });

  describe('recordSweepAmount', () => {
    it('should record sweep amount metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordSweepAmount('optimism', 5.0);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_keyfunder_sweep_amount');
      expect(metricsOutput).toContain('optimism');
    });
  });

  describe('recordOperationDuration', () => {
    it('should record operation duration metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordOperationDuration('base', 'fund', 3.14);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain(
        'hyperlane_keyfunder_operation_duration_seconds',
      );
      expect(metricsOutput).toContain('base');
      expect(metricsOutput).toContain('fund');
    });
  });

  describe('push', () => {
    // eslint-disable-next-line jest/expect-expect -- testing no-throw behavior
    it('should not throw when no push gateway configured', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      await metrics.push();
    });
  });

  describe('with base labels', () => {
    it('should include base labels in all metrics', async () => {
      const metrics = new KeyFunderMetrics(
        { jobName: 'keyfunder-test' },
        { environment: 'mainnet3', region: 'us-east' },
      );

      metrics.recordWalletBalance(
        'ethereum',
        '0x1234567890123456789012345678901234567890',
        'relayer',
        1.0,
      );

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('environment="mainnet3"');
      expect(metricsOutput).toContain('region="us-east"');
    });

    it('should include base labels in unified wallet balance metric', async () => {
      const metrics = new KeyFunderMetrics(
        { jobName: 'keyfunder-test' },
        { environment: 'mainnet3', region: 'us-east' },
      );

      metrics.recordUnifiedWalletBalance(
        'ethereum',
        '0x1234567890123456789012345678901234567890',
        'key-funder',
        1.0,
      );

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).toContain('hyperlane_wallet_balance');
      expect(metricsOutput).toContain('wallet_name="key-funder"');
      expect(metricsOutput).toContain('token_address="native"');
      expect(metricsOutput).toContain('token_symbol="Native"');
      expect(metricsOutput).toContain('token_name="Native"');
      expect(metricsOutput).toContain('environment="mainnet3"');
      expect(metricsOutput).toContain('region="us-east"');
    });
  });
});
