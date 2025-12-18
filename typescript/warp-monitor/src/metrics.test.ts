import { expect } from 'chai';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { TokenStandard } from '@hyperlane-xyz/sdk';

import {
  metricsRegister,
  updateNativeWalletBalanceMetrics,
  updateTokenBalanceMetrics,
  updateXERC20LimitsMetrics,
} from './metrics.js';
import type {
  NativeWalletBalance,
  WarpRouteBalance,
  XERC20Limit,
} from './types.js';

describe('Warp Monitor Metrics', () => {
  beforeEach(() => {
    // Clear registry before each test
    metricsRegister.clear();
  });

  describe('metricsRegister', () => {
    it('should be a valid Prometheus registry', () => {
      expect(metricsRegister).to.be.instanceOf(Registry);
    });

    it('should be able to generate metrics output', async () => {
      const metrics = await metricsRegister.metrics();
      expect(metrics).to.be.a('string');
    });
  });

  describe('updateTokenBalanceMetrics', () => {
    it('should update balance metrics for a token', () => {
      const mockWarpCore = {
        getTokenChains: () => ['ethereum', 'polygon'],
      };

      const mockToken = {
        chainName: 'ethereum',
        name: 'Test Token',
        addressOrDenom: '0x1234567890123456789012345678901234567890',
        standard: TokenStandard.EvmHypCollateral,
      };

      const balanceInfo: WarpRouteBalance = {
        balance: 1000,
        valueUSD: 5000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      // Should not throw
      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'ETH/ethereum-polygon',
      );
    });
  });

  describe('updateNativeWalletBalanceMetrics', () => {
    it('should update native wallet balance metrics', () => {
      const balance: NativeWalletBalance = {
        chain: 'ethereum',
        walletAddress: '0x1234567890123456789012345678901234567890',
        walletName: 'test-wallet',
        balance: 10.5,
      };

      // Should not throw
      updateNativeWalletBalanceMetrics(balance);
    });
  });

  describe('updateXERC20LimitsMetrics', () => {
    it('should update xERC20 limit metrics', () => {
      const mockToken = {
        chainName: 'ethereum',
        name: 'Test xERC20',
      };

      const limits: XERC20Limit = {
        mint: 1000,
        burn: 500,
        mintMax: 10000,
        burnMax: 5000,
      };

      // Should not throw
      updateXERC20LimitsMetrics(
        mockToken as any,
        limits,
        '0x1234567890123456789012345678901234567890',
        'EvmHypXERC20',
        '0xabcdef1234567890123456789012345678901234',
      );
    });
  });
});
