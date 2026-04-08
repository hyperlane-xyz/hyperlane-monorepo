import { expect } from 'chai';
import { ethers } from 'ethers';

import { HyperlaneDeployer } from './HyperlaneDeployer.js';

// Minimal concrete subclass to test protected methods
class TestDeployer extends HyperlaneDeployer<any, any> {
  constructor() {
    // Minimal MultiProvider mock and empty factories
    super({ getChainMetadata: () => ({}) } as any, {});
  }

  deployContracts(): Promise<any> {
    throw new Error('not implemented');
  }

  // Expose protected method for testing
  public testDeriveCacheKey(
    contractName: string,
    constructorArgs: unknown[],
  ): string {
    return this.deriveCacheKey(contractName, constructorArgs);
  }
}

describe('HyperlaneDeployer', () => {
  let deployer: TestDeployer;

  beforeEach(() => {
    deployer = new TestDeployer();
  });

  describe('deriveCacheKey', () => {
    it('returns contractName when args are empty', () => {
      expect(deployer.testDeriveCacheKey('LinearFee', [])).to.equal(
        'LinearFee',
      );
    });

    it('includes hash when args are present', () => {
      const key = deployer.testDeriveCacheKey('LinearFee', ['0xabc', 100, 200]);
      expect(key).to.match(/^LinearFee:[0-9a-f]{8}$/);
    });

    it('returns same key for same args', () => {
      const args = ['0xtoken', 100n, 200n, '0xowner'];
      const key1 = deployer.testDeriveCacheKey('LinearFee', args);
      const key2 = deployer.testDeriveCacheKey('LinearFee', args);
      expect(key1).to.equal(key2);
    });

    it('returns different keys for different args', () => {
      const key1 = deployer.testDeriveCacheKey('LinearFee', [
        '0xtoken',
        100n,
        200n,
        '0xowner',
      ]);
      const key2 = deployer.testDeriveCacheKey('LinearFee', [
        '0xtoken',
        999n,
        888n,
        '0xowner',
      ]);
      expect(key1).to.not.equal(key2);
    });

    it('returns different keys for different contract names', () => {
      const args = ['0xtoken', 100, 200, '0xowner'];
      const key1 = deployer.testDeriveCacheKey('LinearFee', args);
      const key2 = deployer.testDeriveCacheKey('ProgressiveFee', args);
      expect(key1).to.not.equal(key2);
    });

    it('handles BigNumber (ethers v5) in args deterministically', () => {
      const bn = ethers.BigNumber.from('12345678901234567890');
      const key1 = deployer.testDeriveCacheKey('LinearFee', [bn]);
      const key2 = deployer.testDeriveCacheKey('LinearFee', [bn]);
      expect(key1).to.match(/^LinearFee:[0-9a-f]{8}$/);
      expect(key1).to.equal(key2);
    });

    it('handles bigint in args deterministically', () => {
      const key1 = deployer.testDeriveCacheKey('LinearFee', [
        12345678901234567890n,
      ]);
      const key2 = deployer.testDeriveCacheKey('LinearFee', [
        12345678901234567890n,
      ]);
      expect(key1).to.match(/^LinearFee:[0-9a-f]{8}$/);
      expect(key1).to.equal(key2);
    });
  });
});
