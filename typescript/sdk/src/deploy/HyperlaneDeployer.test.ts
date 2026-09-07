import { expect } from 'chai';

import { HyperlaneDeployer } from './HyperlaneDeployer.js';

// Minimal concrete subclass to test protected methods
class TestDeployer extends HyperlaneDeployer<any, any> {
  constructor() {
    super({ getChainMetadata: () => ({}) } as any, {});
  }

  deployContracts(): Promise<any> {
    throw new Error('not implemented');
  }

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

    it('is deterministic', () => {
      const args = ['0xtoken', 100n, 200n, '0xowner'];
      const key1 = deployer.testDeriveCacheKey('LinearFee', args);
      const key2 = deployer.testDeriveCacheKey('LinearFee', args);
      expect(key1).to.equal(key2);
    });

    it('different args produce different keys', () => {
      const key1 = deployer.testDeriveCacheKey('LinearFee', ['0xt', 100n]);
      const key2 = deployer.testDeriveCacheKey('LinearFee', ['0xt', 999n]);
      expect(key1).to.not.equal(key2);
    });

    it('different names produce different keys', () => {
      const args = ['0xtoken', 100];
      const key1 = deployer.testDeriveCacheKey('LinearFee', args);
      const key2 = deployer.testDeriveCacheKey('ProgressiveFee', args);
      expect(key1).to.not.equal(key2);
    });
  });
});
