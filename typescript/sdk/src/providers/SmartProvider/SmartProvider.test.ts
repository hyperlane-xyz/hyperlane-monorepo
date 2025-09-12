import { expect } from 'chai';
import { errors as EthersError } from 'ethers';

import { HyperlaneSmartProvider } from './SmartProvider.js';
import { ProviderStatus } from './types.js';

// Test subclass to expose protected methods for testing
class TestableSmartProvider extends HyperlaneSmartProvider {
  public testThrowCombinedProviderErrors(
    errors: any[],
    fallbackMsg: string,
  ): void {
    return this.throwCombinedProviderErrors(errors, fallbackMsg);
  }
}

describe('SmartProvider Unit Tests', () => {
  let provider: TestableSmartProvider;

  beforeEach(() => {
    // Create a minimal provider for testing
    provider = new TestableSmartProvider(
      { chainId: 1, name: 'test' },
      [{ http: 'http://localhost:8545' }],
      [],
    );
  });

  describe('throwCombinedProviderErrors', () => {
    const blockchainErrorTestCases = [
      {
        code: EthersError.INSUFFICIENT_FUNDS,
        message: 'insufficient funds for intrinsic transaction cost',
      },
      {
        code: EthersError.UNPREDICTABLE_GAS_LIMIT,
        message: 'execution reverted: ERC20: transfer to the zero address',
      },
      {
        code: EthersError.CALL_EXCEPTION,
        message: 'execution reverted',
      },
      {
        code: EthersError.NONCE_EXPIRED,
        message: 'nonce has already been used',
      },
      {
        code: EthersError.REPLACEMENT_UNDERPRICED,
        message: 'replacement transaction underpriced',
      },
      {
        code: EthersError.TRANSACTION_REPLACED,
        message: 'transaction was replaced',
      },
    ];

    blockchainErrorTestCases.forEach(({ code, message }) => {
      it(`throws BlockchainError with isRecoverable=false for ${code}`, () => {
        const error = new Error(message);
        (error as any).code = code;
        (error as any).reason = message;

        try {
          provider.testThrowCombinedProviderErrors(
            [error],
            'Test fallback message',
          );
          expect.fail('Should have thrown an error');
        } catch (e: any) {
          expect(e.name).to.equal('BlockchainError');
          expect(e.isRecoverable).to.equal(false);
          expect(e.message).to.equal(message);
          expect(e.cause).to.equal(error);
          expect(e.cause.code).to.equal(code);
        }
      });
    });

    it('throws regular Error for SERVER_ERROR (not BlockchainError)', () => {
      const error = new Error('connection refused');
      (error as any).code = EthersError.SERVER_ERROR;

      try {
        provider.testThrowCombinedProviderErrors(
          [error],
          'Test fallback message',
        );
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e.name).to.equal('Error');
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(error);
        expect(e.cause.code).to.equal(EthersError.SERVER_ERROR);
      }
    });

    it('throws regular Error for TIMEOUT (not BlockchainError)', () => {
      const error = { status: ProviderStatus.Timeout };

      try {
        provider.testThrowCombinedProviderErrors(
          [error],
          'Test fallback message',
        );
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e.name).to.equal('Error');
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(error);
      }
    });
  });
});
