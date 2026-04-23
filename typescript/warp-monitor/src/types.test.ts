import { expect } from 'vitest';

import type {
  NativeWalletBalance,
  WarpRouteBalance,
  XERC20Limit,
} from '@hyperlane-xyz/metrics';

import type { WarpMonitorConfig } from './types.js';

describe('Warp Monitor Types', () => {
  describe('WarpRouteBalance', () => {
    it('should create a valid WarpRouteBalance object', () => {
      const balance: WarpRouteBalance = {
        balance: 1000,
        valueUSD: 5000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(balance.balance).toBe(1000);
      expect(balance.valueUSD).toBe(5000);
      expect(balance.tokenAddress).toBe(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should allow optional valueUSD', () => {
      const balance: WarpRouteBalance = {
        balance: 1000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(balance.valueUSD).toBeUndefined();
    });
  });

  describe('NativeWalletBalance', () => {
    it('should create a valid NativeWalletBalance object', () => {
      const balance: NativeWalletBalance = {
        chain: 'ethereum',
        walletAddress: '0x1234567890123456789012345678901234567890',
        walletName: 'ata-payer',
        balance: 10.5,
      };

      expect(balance.chain).toBe('ethereum');
      expect(balance.walletAddress).toBe(
        '0x1234567890123456789012345678901234567890',
      );
      expect(balance.walletName).toBe('ata-payer');
      expect(balance.balance).toBe(10.5);
    });
  });

  describe('XERC20Limit', () => {
    it('should create a valid XERC20Limit object', () => {
      const limit: XERC20Limit = {
        mint: 1000,
        burn: 500,
        mintMax: 10000,
        burnMax: 5000,
      };

      expect(limit.mint).toBe(1000);
      expect(limit.burn).toBe(500);
      expect(limit.mintMax).toBe(10000);
      expect(limit.burnMax).toBe(5000);
    });
  });

  describe('WarpMonitorConfig', () => {
    it('should create a valid WarpMonitorConfig object', () => {
      const config: WarpMonitorConfig = {
        warpRouteId: 'ETH/ethereum-polygon',
        checkFrequency: 30000,
        coingeckoApiKey: 'test-api-key',
        registryUri: 'https://github.com/hyperlane-xyz/hyperlane-registry',
        explorerApiUrl: 'https://explorer4.hasura.app/v1/graphql',
        explorerQueryLimit: 500,
        inventoryAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(config.warpRouteId).toBe('ETH/ethereum-polygon');
      expect(config.checkFrequency).toBe(30000);
      expect(config.coingeckoApiKey).toBe('test-api-key');
      expect(config.registryUri).toBe(
        'https://github.com/hyperlane-xyz/hyperlane-registry',
      );
      expect(config.explorerApiUrl).toBe(
        'https://explorer4.hasura.app/v1/graphql',
      );
      expect(config.explorerQueryLimit).toBe(500);
      expect(config.inventoryAddress).toBe(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should allow optional fields', () => {
      const config: WarpMonitorConfig = {
        warpRouteId: 'ETH/ethereum-polygon',
        checkFrequency: 30000,
      };

      expect(config.coingeckoApiKey).toBeUndefined();
      expect(config.registryUri).toBeUndefined();
      expect(config.explorerApiUrl).toBeUndefined();
      expect(config.explorerQueryLimit).toBeUndefined();
      expect(config.inventoryAddress).toBeUndefined();
    });
  });
});
