import { expect } from 'chai';

import { TestChainName, testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { SealevelIgpAdapter } from './SealevelIgpAdapter.js';
import {
  SealevelGasOracle,
  SealevelGasOracleType,
  SealevelRemoteGasData,
} from './serialization.js';

describe('SealevelIgpAdapter', () => {
  let adapter: SealevelIgpAdapter;
  let multiProvider: MultiProtocolProvider;

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    adapter = new SealevelIgpAdapter(TestChainName.test1, multiProvider, {
      igp: '11111111111111111111111111111111',
      programId: '11111111111111111111111111111111',
    });
  });

  describe('gasOracleMatches', () => {
    const createMockRemoteGasData = (
      tokenExchangeRate: bigint | number,
      gasPrice: bigint | number,
      tokenDecimals: number,
    ): SealevelRemoteGasData => {
      return new SealevelRemoteGasData({
        token_exchange_rate: tokenExchangeRate,
        gas_price: gasPrice,
        token_decimals: tokenDecimals,
      });
    };

    const createMockGasOracle = (
      remoteGasData: SealevelRemoteGasData,
    ): SealevelGasOracle => {
      return new SealevelGasOracle({
        type: SealevelGasOracleType.RemoteGasData,
        data: remoteGasData,
      });
    };

    describe('when currentOracle is undefined', () => {
      it('should return matches: false and actual: null', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const result = adapter.gasOracleMatches(undefined, expected);

        expect(result.matches).to.be.false;
        expect(result.actual).to.be.null;
      });
    });

    describe('when currentOracle matches expected exactly', () => {
      it('should return matches: true with correct actual data', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const currentOracle = createMockGasOracle(expected);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(expected);
      });

      it('should work with number types instead of BigInt', () => {
        const expected = createMockRemoteGasData(1000, 2000, 18);
        const currentOracle = createMockGasOracle(expected);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(expected);
      });
    });

    describe('when token_exchange_rate differs', () => {
      it('should return matches: false', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1500n, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.false;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should work with mixed BigInt and number types', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1000, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });
    });

    describe('when gas_price differs', () => {
      it('should return matches: false', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1000n, 2500n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.false;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should work with mixed BigInt and number types', () => {
        const expected = createMockRemoteGasData(1000n, 2000, 18);
        const actual = createMockRemoteGasData(1000n, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });
    });

    describe('when token_decimals differs', () => {
      it('should return matches: false', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1000n, 2000n, 6);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.false;
        expect(result.actual).to.deep.equal(actual);
      });
    });

    describe('BigInt type conversion handling', () => {
      it('should handle BigInt to number conversion for token_exchange_rate', () => {
        const expected = createMockRemoteGasData(1000, 2000n, 18);
        const actual = createMockRemoteGasData(1000n, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should handle BigInt to number conversion for gas_price', () => {
        const expected = createMockRemoteGasData(1000n, 2000, 18);
        const actual = createMockRemoteGasData(1000n, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should handle number to BigInt conversion for token_exchange_rate', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1000, 2000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should handle number to BigInt conversion for gas_price', () => {
        const expected = createMockRemoteGasData(1000n, 2000n, 18);
        const actual = createMockRemoteGasData(1000n, 2000, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });
    });

    describe('edge cases', () => {
      it('should handle zero values correctly', () => {
        const expected = createMockRemoteGasData(0n, 0n, 0);
        const actual = createMockRemoteGasData(0n, 0n, 0);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should handle very large BigInt values', () => {
        const largeValue = BigInt('999999999999999999999999999999999999');
        const expected = createMockRemoteGasData(largeValue, largeValue, 18);
        const actual = createMockRemoteGasData(largeValue, largeValue, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should handle mixed zero and non-zero values', () => {
        const expected = createMockRemoteGasData(0n, 1000n, 18);
        const actual = createMockRemoteGasData(0n, 1000n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.true;
        expect(result.actual).to.deep.equal(actual);
      });

      it('should fail when zero values differ from non-zero', () => {
        const expected = createMockRemoteGasData(0n, 1000n, 18);
        const actual = createMockRemoteGasData(1000n, 0n, 18);
        const currentOracle = createMockGasOracle(actual);
        const result = adapter.gasOracleMatches(currentOracle, expected);

        expect(result.matches).to.be.false;
        expect(result.actual).to.deep.equal(actual);
      });
    });

    describe('comprehensive type mixing scenarios', () => {
      it('should handle all combinations of BigInt and number types', () => {
        const testCases = [
          { expected: [1000n, 2000n], actual: [1000, 2000] },
          { expected: [1000, 2000n], actual: [1000n, 2000] },
          { expected: [1000n, 2000], actual: [1000, 2000n] },
          { expected: [1000, 2000], actual: [1000n, 2000n] },
        ];

        testCases.forEach(({ expected, actual }) => {
          const expectedData = createMockRemoteGasData(
            expected[0],
            expected[1],
            18,
          );
          const actualData = createMockRemoteGasData(actual[0], actual[1], 18);
          const currentOracle = createMockGasOracle(actualData);
          const result = adapter.gasOracleMatches(currentOracle, expectedData);

          expect(result.matches).to.be.true;
          expect(result.actual).to.deep.equal(actualData);
        });
      });
    });
  });
});
