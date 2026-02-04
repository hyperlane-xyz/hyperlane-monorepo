import { expect } from 'chai';

import { TronProvider } from '../clients/provider.js';

describe('TronProvider', () => {
  describe('constructor', () => {
    it('should create a provider with valid options', () => {
      const provider = new TronProvider('https://api.trongrid.io', 728126428);
      expect(provider).to.be.instanceOf(TronProvider);
      expect(provider.getRpcUrls()).to.deep.equal(['https://api.trongrid.io']);
    });

    it('should create a provider with array of URLs', () => {
      const rpcUrls = ['https://api.trongrid.io', 'https://api.tronstack.io'];
      const provider = new TronProvider(rpcUrls, 728126428);
      expect(provider).to.be.instanceOf(TronProvider);
      expect(provider.getRpcUrls()).to.deep.equal(rpcUrls);
    });

    it('should throw error with empty rpcUrls', () => {
      expect(() => new TronProvider([], 728126428)).to.throw(
        'At least one RPC URL required',
      );
    });
  });

  describe('static connect', () => {
    it('should create a provider using connect method', () => {
      const provider = TronProvider.connect(
        'https://api.trongrid.io',
        728126428,
      );
      expect(provider).to.be.instanceOf(TronProvider);
    });

    it('should create a provider with array of URLs', () => {
      const provider = TronProvider.connect(
        ['https://api.trongrid.io'],
        728126428,
      );
      expect(provider).to.be.instanceOf(TronProvider);
    });
  });

  describe('getRpcUrls', () => {
    it('should return the configured RPC URLs', () => {
      const rpcUrls = ['https://api.trongrid.io', 'https://api.tronstack.io'];
      const provider = new TronProvider(rpcUrls, 728126428);
      expect(provider.getRpcUrls()).to.deep.equal(rpcUrls);
    });
  });

  // Note: The following tests require network access or mocking
  // They are skipped by default but can be enabled for integration testing

  describe('network operations (requires live network)', function () {
    // Skip these tests by default - they require live network access
    // Remove .skip to run against Tron mainnet/testnet
    let provider: TronProvider;

    before(function () {
      // Use Shasta testnet for testing
      provider = new TronProvider(
        'https://api.shasta.trongrid.io',
        2494104990, // Shasta testnet
      );
    });

    it.skip('should check health', async function () {
      this.timeout(10000);
      const isHealthy = await provider.isHealthy();
      expect(typeof isHealthy).to.equal('boolean');
    });

    it.skip('should get block height', async function () {
      this.timeout(10000);
      const height = await provider.getBlockHeight();
      expect(height).to.be.a('number');
      expect(height).to.be.greaterThan(0);
    });

    it.skip('should get balance', async function () {
      this.timeout(10000);
      // Use a known address with balance on Shasta testnet
      const balance = await provider.getBalance(
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      );
      expect(typeof balance).to.equal('bigint');
    });

    it.skip('should get energy price', async function () {
      this.timeout(10000);
      const price = await provider.getEnergyPrice();
      expect(price).to.be.a('number');
      expect(price).to.be.greaterThan(0);
    });
  });
});
