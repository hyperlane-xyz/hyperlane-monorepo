import { expect } from 'chai';
import { errors as EthersError, providers } from 'ethers';

import { AllProviderMethods, IProviderMethods } from './ProviderMethods.js';
import { BlockchainError, HyperlaneSmartProvider } from './SmartProvider.js';
import { ProviderStatus } from './types.js';

// Dummy provider for testing
class MockProvider extends providers.BaseProvider implements IProviderMethods {
  public readonly supportedMethods = AllProviderMethods;
  public called = false;
  public thrownError?: Error;

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
      this.thrownError = this.errorToThrow;
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
  public readonly data?: string;

  constructor(message: string, code: string, data?: string) {
    super(message);
    this.reason = message;
    this.code = code;
    this.data = data;
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
        data: '0x08c379a0', // Must have revert data to be permanent error
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

    blockchainErrorTestCases.forEach(({ code, message, data }) => {
      it(`throws BlockchainError with isRecoverable=false for ${code}`, () => {
        const error = new ProviderError(message, code, data);
        const CombinedError = provider.testGetCombinedProviderError(
          [error],
          'Test fallback message',
        );

        const e: any = new CombinedError();

        expect(e).to.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal(message);
        expect(e.cause).to.equal(error);
        expect(e.cause.code).to.equal(code);
      });
    });

    it('throws regular Error for SERVER_ERROR (not BlockchainError)', () => {
      const error = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      expect(e.isRecoverable).to.be.undefined;
      expect(e.cause).to.equal(error);
      expect(e.cause.code).to.equal(EthersError.SERVER_ERROR);
    });

    it('throws regular Error for TIMEOUT (not BlockchainError)', () => {
      const error = { status: ProviderStatus.Timeout };
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      expect(e.isRecoverable).to.be.undefined;
      expect(e.cause).to.equal(error);
    });

    const mixedErrorTestCases = [
      {
        name: 'SERVER_ERROR',
        errors: () => [
          new ProviderError('connection refused', EthersError.SERVER_ERROR),
          new ProviderError(
            'execution reverted',
            EthersError.CALL_EXCEPTION,
            '0x08c379a0', // Must have revert data to be prioritized as blockchain error
          ),
        ],
        expectedMessage: 'execution reverted',
      },
      {
        name: 'TIMEOUT',
        errors: () => [
          { status: ProviderStatus.Timeout },
          new ProviderError(
            'insufficient funds',
            EthersError.INSUFFICIENT_FUNDS,
          ),
        ],
        expectedMessage: 'insufficient funds',
      },
    ];

    mixedErrorTestCases.forEach(({ name, errors, expectedMessage }) => {
      it(`prioritizes BlockchainError when mixed with ${name}`, () => {
        const [firstError, secondError] = errors();
        const CombinedError = provider.testGetCombinedProviderError(
          [firstError, secondError],
          'Test fallback message',
        );

        const e = new CombinedError();

        expect(e).to.be.instanceOf(BlockchainError);
        expect((e as BlockchainError).isRecoverable).to.equal(false);
        expect(e.message).to.equal(expectedMessage);
        expect(e.cause).to.equal(secondError);
      });
    });

    it('treats CALL_EXCEPTION without revert data as recoverable (not BlockchainError)', () => {
      // CALL_EXCEPTION without data is likely an RPC issue, not a real revert
      const error = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        // No data property - treated as transient RPC error
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      // Without revert data, this should NOT be a BlockchainError
      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      // Falls through to generic error handler (unhandled case)
      expect(e.message).to.equal('Test fallback message');
    });

    it('treats CALL_EXCEPTION with empty "0x" data as recoverable (not BlockchainError)', () => {
      // ethers sets data to "0x" when there's no actual revert data
      const error = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data - treated as transient RPC error
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      // With empty "0x" data, this should NOT be a BlockchainError
      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      // Falls through to generic error handler (unhandled case)
      expect(e.message).to.equal('Test fallback message');
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
      expect(provider1.thrownError).to.equal(serverError);
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
        expect(provider1.thrownError).to.equal(serverError1);
        expect(provider2.called).to.be.true;
        expect(provider2.thrownError).to.equal(serverError2);
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

    it('blockchain error with revert data stops trying additional providers immediately', async () => {
      const blockchainError = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        '0x08c379a0', // Must have revert data to stop fallback
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
        expect(provider1.thrownError).to.equal(blockchainError);
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
        expect(provider1.thrownError).to.equal(serverError);
        expect(provider2.called).to.be.true;
        expect(provider2.thrownError).to.equal(blockchainError);
      }
    });

    it('CALL_EXCEPTION without revert data triggers fallback to next provider', async () => {
      // CALL_EXCEPTION without data is likely an RPC issue, should retry
      const callExceptionNoData = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        // No data - treated as transient RPC error
      );

      const provider1 = MockProvider.error(callExceptionNoData);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      // Should succeed from second provider
      expect(result).to.deep.equal('success2');
      expect(provider1.called).to.be.true;
      expect(provider1.thrownError).to.equal(callExceptionNoData);
      expect(provider2.called).to.be.true; // Key test - second provider SHOULD be called
    });

    it('CALL_EXCEPTION with empty "0x" data triggers fallback to next provider', async () => {
      // ethers sets data to "0x" when there's no actual revert data
      const callExceptionEmptyData = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data - treated as transient RPC error
      );

      const provider1 = MockProvider.error(callExceptionEmptyData);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      // Should succeed from second provider
      expect(result).to.deep.equal('success2');
      expect(provider1.called).to.be.true;
      expect(provider1.thrownError).to.equal(callExceptionEmptyData);
      expect(provider2.called).to.be.true; // Key test - second provider SHOULD be called
    });
  });
});
