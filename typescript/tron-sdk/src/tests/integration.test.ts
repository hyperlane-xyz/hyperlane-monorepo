import { expect } from 'chai';

import { TronProvider } from '../clients/provider.js';

/**
 * Integration tests that require network access.
 * These tests hit the Tron Shasta testnet to verify the SDK works correctly.
 *
 * Run with: TRON_INTEGRATION=true pnpm -C typescript/tron-sdk test
 */
describe('Tron Integration Tests', function () {
  // Shasta testnet configuration
  const SHASTA_RPC = 'https://api.shasta.trongrid.io';
  const SHASTA_CHAIN_ID = 2494104990;

  // Only run if TRON_INTEGRATION env var is set
  const shouldRun = process.env.TRON_INTEGRATION === 'true';

  let provider: TronProvider;

  before(function () {
    if (!shouldRun) {
      this.skip();
    }
    provider = new TronProvider(SHASTA_RPC, SHASTA_CHAIN_ID);
  });

  describe('Network connectivity', function () {
    it('should report healthy status', async function () {
      this.timeout(15000);
      const isHealthy = await provider.isHealthy();
      expect(isHealthy).to.be.true;
    });

    it('should get current block height', async function () {
      this.timeout(15000);
      const height = await provider.getBlockHeight();
      expect(height).to.be.a('number');
      expect(height).to.be.greaterThan(0);
      console.log(`    Current Shasta block height: ${height}`);
    });
  });

  describe('Account operations', function () {
    it('should get balance of zero address', async function () {
      this.timeout(15000);
      // Zero address - query should not throw
      const balance = await provider.getBalance(
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      );
      expect(typeof balance).to.equal('bigint');
      // Note: The zero address may have balance from errant transfers
      console.log(`    Zero address balance: ${balance} sun`);
    });

    it('should get balance of a funded testnet address', async function () {
      this.timeout(15000);
      // This is a well-known Shasta faucet address that should have funds
      // If this test fails, the address may have been depleted
      const balance = await provider.getBalance(
        'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a', // Shasta faucet
      );
      expect(typeof balance).to.equal('bigint');
      // Faucet should have some balance
      console.log(`    Faucet balance: ${balance} sun`);
    });
  });

  describe('Fee estimation', function () {
    it('should get current energy price', async function () {
      this.timeout(15000);
      const energyPrice = await provider.getEnergyPrice();
      expect(energyPrice).to.be.a('number');
      expect(energyPrice).to.be.greaterThan(0);
      console.log(`    Current energy price: ${energyPrice} sun/energy`);
    });

    it('should get current bandwidth price', async function () {
      this.timeout(15000);
      const bandwidthPrice = await provider.getBandwidthPrice();
      expect(bandwidthPrice).to.be.a('number');
      expect(bandwidthPrice).to.be.greaterThan(0);
      console.log(
        `    Current bandwidth price: ${bandwidthPrice} sun/bandwidth`,
      );
    });
  });
});
