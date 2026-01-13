import { expect } from 'chai';

import type {
  NativeWalletBalance,
  WarpMonitorConfig,
  WarpRouteBalance,
  XERC20Limit,
} from './types.js';

describe('Warp Monitor Types', () => {
  describe('WarpRouteBalance', () => {
    it('should create a valid WarpRouteBalance object', () => {
      const balance: WarpRouteBalance = {
        balance: 1000,
        valueUSD: 5000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(balance.balance).to.equal(1000);
      expect(balance.valueUSD).to.equal(5000);
      expect(balance.tokenAddress).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
    });

    it('should allow optional valueUSD', () => {
      const balance: WarpRouteBalance = {
        balance: 1000,
        tokenAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(balance.valueUSD).to.be.undefined;
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

      expect(balance.chain).to.equal('ethereum');
      expect(balance.walletAddress).to.equal(
        '0x1234567890123456789012345678901234567890',
      );
      expect(balance.walletName).to.equal('ata-payer');
      expect(balance.balance).to.equal(10.5);
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

      expect(limit.mint).to.equal(1000);
      expect(limit.burn).to.equal(500);
      expect(limit.mintMax).to.equal(10000);
      expect(limit.burnMax).to.equal(5000);
    });
  });

  describe('WarpMonitorConfig', () => {
    it('should create a valid WarpMonitorConfig object', () => {
      const config: WarpMonitorConfig = {
        warpRouteId: 'ETH/ethereum-polygon',
        checkFrequency: 30000,
        coingeckoApiKey: 'test-api-key',
        registryUri: 'https://github.com/hyperlane-xyz/hyperlane-registry',
      };

      expect(config.warpRouteId).to.equal('ETH/ethereum-polygon');
      expect(config.checkFrequency).to.equal(30000);
      expect(config.coingeckoApiKey).to.equal('test-api-key');
      expect(config.registryUri).to.equal(
        'https://github.com/hyperlane-xyz/hyperlane-registry',
      );
    });

    it('should allow optional fields', () => {
      const config: WarpMonitorConfig = {
        warpRouteId: 'ETH/ethereum-polygon',
        checkFrequency: 30000,
      };

      expect(config.coingeckoApiKey).to.be.undefined;
      expect(config.registryUri).to.be.undefined;
    });
  });
});
