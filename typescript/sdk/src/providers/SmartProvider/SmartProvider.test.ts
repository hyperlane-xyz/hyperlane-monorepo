import { expect } from 'chai';
import { errors as EthersError, providers } from 'ethers';

import { AllProviderMethods, IProviderMethods } from './ProviderMethods.js';
import { BlockchainError, HyperlaneSmartProvider } from './SmartProvider.js';
import { ProviderStatus } from './types.js';

// Dummy provider for testing
class MockProvider extends providers.BaseProvider implements IProviderMethods {
  public readonly supportedMethods = AllProviderMethods;
  public called = false;

  static success(successValue?: any, responseDelayMs = 0) {
    return new MockProvider(
      'http://provider',
      undefined,
      successValue,
      responseDelayMs,
    );
  }

  static error(errorToThrow: Error, responseDelayMs = 0) {
    return new MockProvider(
      'http://provider',
      errorToThrow,
      undefined,
      responseDelayMs,
    );
  }

  constructor(
    private readonly baseUrl: string,
    private readonly errorToThrow?: Error,
    private readonly successValue?: any,
    private readonly responseDelayMs = 0,
  ) {
    super({ name: 'test', chainId: 1 });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async perform(_method: string, _params: any, _reqId?: number): Promise<any> {
    this.called = true;

    if (this.responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));
    }

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    return this.successValue ?? 'success';
  }

  // Required BaseProvider methods - minimal implementations
  async detectNetwork() {
    return { name: 'test', chainId: 1 };
  }
}

class TestableSmartProvider extends HyperlaneSmartProvider {
  constructor(public readonly mockProviders: MockProvider[]) {
    super(
      { chainId: 1, name: 'test' },
      mockProviders.map((p) => ({ http: p.getBaseUrl() })),
      [],
      { fallbackStaggerMs: 50 },
    );
  }

  public testGetCombinedProviderError(
    errors: any[],
    fallbackMsg: string,
  ): new () => Error {
    return this.getCombinedProviderError(errors, fallbackMsg);
  }

  public async simplePerform(method: string, reqId: number): Promise<any> {
    return this.performWithFallback(
      method,
      {},
      this.mockProviders as any,
      reqId,
    );
  }
}

class ProviderError extends Error {
  public readonly reason: string;
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.reason = message;
    this.code = code;
  }
}

describe('SmartProvider', () => {
  let provider: TestableSmartProvider;

  beforeEach(() => {
    provider = new TestableSmartProvider([MockProvider.success('success')]);
  });

  describe('getCombinedProviderError', () => {
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
        const error = new ProviderError(message, code);

        try {
          const CombinedError = provider.testGetCombinedProviderError(
            [error],
            'Test fallback message',
          );
          throw new CombinedError();
        } catch (e: any) {
          expect(e).to.be.instanceOf(BlockchainError);
          expect(e.isRecoverable).to.equal(false);
          expect(e.message).to.equal(message);
          expect(e.cause).to.equal(error);
          expect(e.cause.code).to.equal(code);
        }
      });
    });

    it('throws regular Error for SERVER_ERROR (not BlockchainError)', () => {
      const error = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [error],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e).to.be.instanceOf(Error);
        expect(e).to.not.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(error);
        expect(e.cause.code).to.equal(EthersError.SERVER_ERROR);
      }
    });

    it('throws regular Error for TIMEOUT (not BlockchainError)', () => {
      const error = { status: ProviderStatus.Timeout };

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [error],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e).to.be.instanceOf(Error);
        expect(e).to.not.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(error);
      }
    });

    it('prioritizes BlockchainError when mixed with SERVER_ERROR', () => {
      const serverError = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );
      const blockchainError = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
      );

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [serverError, blockchainError],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('execution reverted');
        expect(e.cause).to.equal(blockchainError);
      }
    });

    it('prioritizes BlockchainError when mixed with TIMEOUT', () => {
      const timeoutError = { status: ProviderStatus.Timeout };
      const blockchainError = new ProviderError(
        'insufficient funds',
        EthersError.INSUFFICIENT_FUNDS,
      );

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [timeoutError, blockchainError],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('insufficient funds');
        expect(e.cause).to.equal(blockchainError);
      }
    });
  });

  describe('performWithFallback', () => {
    it('returns success from first provider, second provider not called', async () => {
      const provider1 = MockProvider.success('success1');
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      expect(result).to.deep.equal('success1');
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.false;
    });

    it('calls second provider when first throws server error, returns success from second', async () => {
      const serverError = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );

      const provider1 = MockProvider.error(serverError);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      expect(result).to.deep.equal('success2');
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('calls second provider when first times out, returns success from second', async () => {
      const provider1 = MockProvider.success('success1', 100);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      expect(result).to.deep.equal('success2');
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('both providers timeout, first provider ultimately returns result (waitForProviderSuccess)', async () => {
      const provider1 = MockProvider.success('success1', 120); // 120ms delay
      const provider2 = MockProvider.success('success2', 200); // 200ms delay
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      expect(result).to.deep.equal('success1');
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('both providers throw errors, combined error is thrown', async () => {
      const serverError1 = new ProviderError(
        'connection refused 1',
        EthersError.SERVER_ERROR,
      );
      const serverError2 = new ProviderError(
        'connection refused 2',
        EthersError.SERVER_ERROR,
      );

      const provider1 = MockProvider.error(serverError1);
      const provider2 = MockProvider.error(serverError2);
      const provider = new TestableSmartProvider([provider1, provider2]);

      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(Error);
        expect(e).to.not.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(serverError1); // First error should be the cause
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.true;
      }
    });

    it('both providers timeout, combined timeout error is thrown', async () => {
      const provider1 = MockProvider.success('success1', 2000);
      const provider2 = MockProvider.success('success2', 2000);
      const provider = new TestableSmartProvider([provider1, provider2]);

      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(Error);
        expect(e).to.not.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.be.undefined;
        expect(e.message).to.include('All providers timed out');
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.true;
      }
    });

    it('blockchain error stops trying additional providers immediately', async () => {
      const blockchainError = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
      );

      const provider1 = MockProvider.error(blockchainError);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);
      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('execution reverted');
        expect(e.cause).to.equal(blockchainError);
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.false; // Key test - second provider should NOT be called
      }
    });

    it('blockchain error takes priority over server error in actual flow', async () => {
      const serverError = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );
      const blockchainError = new ProviderError(
        'insufficient funds',
        EthersError.INSUFFICIENT_FUNDS,
      );

      const provider1 = MockProvider.error(serverError);
      const provider2 = MockProvider.error(blockchainError);
      const provider = new TestableSmartProvider([provider1, provider2]);

      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError); // Should get blockchain error, not server error
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('insufficient funds');
        expect(e.cause).to.equal(blockchainError);
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.true;
      }
    });
  });
});
