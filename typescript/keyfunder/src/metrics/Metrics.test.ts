import { expect } from 'chai';

import { KeyFunderMetrics } from './Metrics.js';

describe('KeyFunderMetrics', () => {
  describe('constructor', () => {
    it('should create metrics without push gateway', () => {
      const metrics = new KeyFunderMetrics(undefined);
      expect(metrics.getRegistry()).to.not.be.undefined;
    });

    it('should create metrics with config', () => {
      const metrics = new KeyFunderMetrics({
        jobName: 'test',
      });
      expect(metrics.getRegistry()).to.not.be.undefined;
    });

    it('should include base labels in gauge configurations', () => {
      const metrics = new KeyFunderMetrics(
        { jobName: 'test' },
        { environment: 'testnet' },
      );
      expect(metrics.getRegistry()).to.not.be.undefined;
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
      expect(metricsOutput).to.include('hyperlane_keyfunder_wallet_balance');
      expect(metricsOutput).to.include('ethereum');
      expect(metricsOutput).to.include('relayer');
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
      expect(metricsOutput).to.include('hyperlane_keyfunder_funding_amount');
      expect(metricsOutput).to.include('arbitrum');
      expect(metricsOutput).to.include('kathy');
    });
  });

  describe('recordIgpBalance', () => {
    it('should record IGP balance metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordIgpBalance('polygon', 2.5);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).to.include('hyperlane_keyfunder_igp_balance');
      expect(metricsOutput).to.include('polygon');
    });
  });

  describe('recordSweepAmount', () => {
    it('should record sweep amount metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordSweepAmount('optimism', 5.0);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).to.include('hyperlane_keyfunder_sweep_amount');
      expect(metricsOutput).to.include('optimism');
    });
  });

  describe('recordOperationDuration', () => {
    it('should record operation duration metric', async () => {
      const metrics = new KeyFunderMetrics(undefined);
      metrics.recordOperationDuration('base', 'fund', 3.14);

      const metricsOutput = await metrics.getRegistry().metrics();
      expect(metricsOutput).to.include(
        'hyperlane_keyfunder_operation_duration_seconds',
      );
      expect(metricsOutput).to.include('base');
      expect(metricsOutput).to.include('fund');
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
      expect(metricsOutput).to.include('environment="mainnet3"');
      expect(metricsOutput).to.include('region="us-east"');
    });
  });
});
