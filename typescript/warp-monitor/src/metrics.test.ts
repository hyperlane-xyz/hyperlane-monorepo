import { expect } from 'chai';
import { Registry } from 'prom-client';

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
  // Note: We don't clear the registry between tests because the gauges are
  // registered at module load time. Clearing would remove the gauge registrations.

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
    const createMockWarpCore = (chains: string[]) => ({
      getTokenChains: () => chains,
    });

    const createMockToken = (
      chainName: string,
      name: string,
      standard: TokenStandard,
    ) => ({
      chainName,
      name,
      addressOrDenom: '0x1234567890123456789012345678901234567890',
      standard,
    });

    it('should record token balance with correct value', async () => {
      const mockWarpCore = createMockWarpCore(['ethereum', 'polygon']);
      const mockToken = createMockToken(
        'ethereum',
        'Test Token',
        TokenStandard.EvmHypCollateral,
      );

      const balanceInfo: WarpRouteBalance = {
        balance: 1000.5,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'ETH/ethereum-polygon',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_warp_route_token_balance');
      expect(metrics).to.include('chain_name="ethereum"');
      expect(metrics).to.include('token_name="Test Token"');
      expect(metrics).to.include('warp_route_id="ETH/ethereum-polygon"');
      expect(metrics).to.include('1000.5');
    });

    it('should record collateral value when valueUSD is provided', async () => {
      const mockWarpCore = createMockWarpCore(['ethereum', 'polygon']);
      const mockToken = createMockToken(
        'ethereum',
        'Collateral Token',
        TokenStandard.EvmHypCollateral,
      );

      const balanceInfo: WarpRouteBalance = {
        balance: 1000,
        valueUSD: 5000.25,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'ETH/collateral-test',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_warp_route_collateral_value');
      expect(metrics).to.include('5000.25');
    });

    it('should record value at risk for all chains in warp route', async () => {
      const mockWarpCore = createMockWarpCore([
        'ethereum',
        'polygon',
        'arbitrum',
      ]);
      const mockToken = createMockToken(
        'ethereum',
        'MultiChain Token',
        TokenStandard.EvmHypCollateral,
      );

      const balanceInfo: WarpRouteBalance = {
        balance: 1000,
        valueUSD: 5000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'ETH/multichain-test',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_warp_route_value_at_risk');
    });

    it('should set related_chain_names excluding current chain', async () => {
      const mockWarpCore = createMockWarpCore([
        'ethereum',
        'polygon',
        'arbitrum',
      ]);
      const mockToken = createMockToken(
        'ethereum',
        'Related Chains Token',
        TokenStandard.EvmHypCollateral,
      );

      const balanceInfo: WarpRouteBalance = {
        balance: 1000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'ETH/related-test',
      );

      const metrics = await metricsRegister.metrics();
      // Related chains should exclude 'ethereum' (the current chain) and be sorted
      expect(metrics).to.include('related_chain_names="arbitrum,polygon"');
    });

    it('should handle xERC20 tokens with correct standard label', async () => {
      const mockWarpCore = createMockWarpCore(['ethereum', 'polygon']);
      const mockToken = createMockToken(
        'ethereum',
        'xERC20 Token',
        TokenStandard.EvmHypXERC20,
      );

      const balanceInfo: WarpRouteBalance = {
        balance: 1000,
        tokenAddress: '0xabcdef1234567890123456789012345678901234',
      };

      updateTokenBalanceMetrics(
        mockWarpCore as any,
        mockToken as any,
        balanceInfo,
        'xERC20/test',
      );

      const metrics = await metricsRegister.metrics();
      // xERC20 tokens should be labeled as 'xERC20' not 'EvmHypXERC20'
      expect(metrics).to.include('token_standard="xERC20"');
    });
  });

  describe('updateNativeWalletBalanceMetrics', () => {
    it('should record native wallet balance with correct labels', async () => {
      const balance: NativeWalletBalance = {
        chain: 'solanamainnet',
        walletAddress: 'SoLaNaAdDrEsS123456789012345678901234567890',
        walletName: 'ETH/ethereum-solanamainnet/ata-payer',
        balance: 0.5,
      };

      updateNativeWalletBalanceMetrics(balance);

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_wallet_balance');
      expect(metrics).to.include('chain="solanamainnet"');
      expect(metrics).to.include(
        'wallet_address="SoLaNaAdDrEsS123456789012345678901234567890"',
      );
      expect(metrics).to.include(
        'wallet_name="ETH/ethereum-solanamainnet/ata-payer"',
      );
      expect(metrics).to.include('token_symbol="Native"');
    });

    it('should handle small balance values', async () => {
      const smallBalance: NativeWalletBalance = {
        chain: 'ethereum',
        walletAddress: '0xSmallBalance12345678901234567890123456',
        walletName: 'small-wallet',
        balance: 0.0001,
      };

      updateNativeWalletBalanceMetrics(smallBalance);

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include(
        'wallet_address="0xSmallBalance12345678901234567890123456"',
      );
    });
  });

  describe('updateXERC20LimitsMetrics', () => {
    const mockToken = {
      chainName: 'ethereum',
      name: 'Test xERC20 Limits',
    };

    it('should record all four limit types', async () => {
      const limits: XERC20Limit = {
        mint: 1000,
        burn: 500,
        mintMax: 10000,
        burnMax: 5000,
      };

      updateXERC20LimitsMetrics(
        mockToken as any,
        limits,
        '0xLimitsTest123456789012345678901234567890',
        'EvmHypXERC20',
        '0xabcdef1234567890123456789012345678901234',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_xerc20_limits');
      expect(metrics).to.include('limit_type="mint"');
      expect(metrics).to.include('limit_type="burn"');
      expect(metrics).to.include('limit_type="mintMax"');
      expect(metrics).to.include('limit_type="burnMax"');
    });

    it('should record bridge address and label', async () => {
      const limits: XERC20Limit = {
        mint: 2000,
        burn: 1500,
        mintMax: 20000,
        burnMax: 15000,
      };

      updateXERC20LimitsMetrics(
        mockToken as any,
        limits,
        '0xBridgeAddress1234567890123456789012345678',
        'EvmManagedLockbox',
        '0xabcdef1234567890123456789012345678901234',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include(
        'bridge_address="0xBridgeAddress1234567890123456789012345678"',
      );
      expect(metrics).to.include('bridge_label="EvmManagedLockbox"');
    });

    it('should handle zero limits gracefully', async () => {
      const limits: XERC20Limit = {
        mint: 0,
        burn: 0,
        mintMax: 10000,
        burnMax: 5000,
      };

      // Should not throw
      updateXERC20LimitsMetrics(
        mockToken as any,
        limits,
        '0xZeroLimits123456789012345678901234567890',
        'EvmHypXERC20',
        '0xabcdef1234567890123456789012345678901234',
      );

      const metrics = await metricsRegister.metrics();
      expect(metrics).to.include('hyperlane_xerc20_limits');
      expect(metrics).to.include(
        'bridge_address="0xZeroLimits123456789012345678901234567890"',
      );
    });
  });
});
