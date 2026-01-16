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
  public readonly error?: { error?: { code?: number } };

  constructor(
    message: string,
    code: string,
    data?: string,
    options?: { jsonRpcErrorCode?: number; hasNestedError?: boolean },
  ) {
    super(message);
    this.reason = message;
    this.code = code;
    this.data = data;
    // Simulate ethers nested error structure for JSON-RPC errors
    if (options?.jsonRpcErrorCode !== undefined) {
      this.error = { error: { code: options.jsonRpcErrorCode } };
    } else if (options?.hasNestedError) {
      // Has nested error but no JSON-RPC code (e.g., RPC connection issue)
      this.error = { error: {} };
    }
    // If neither is set, error remains undefined (empty return decode failure)
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

    it('treats CALL_EXCEPTION without nested error as permanent (BlockchainError)', () => {
      // CALL_EXCEPTION without nested error means ethers failed to decode empty return data
      // This is permanent - retrying won't help since the contract doesn't have this method
      const error = new ProviderError(
        'call revert exception',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data from contract
        // No options = no nested error = decode failure
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      // Without nested error, this IS a BlockchainError (decode failure is permanent)
      expect(e).to.be.instanceOf(BlockchainError);
      expect(e.isRecoverable).to.equal(false);
    });

    it('treats CALL_EXCEPTION with nested RPC error (not code 3) as recoverable', () => {
      // CALL_EXCEPTION with nested error but not code 3 is likely an RPC issue
      const error = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data
        { hasNestedError: true }, // Has nested error but no code 3
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      // With nested error but no code 3, this should NOT be a BlockchainError
      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      // Falls through to generic error handler (unhandled case)
      expect(e.message).to.equal('Test fallback message');
    });

    it('treats CALL_EXCEPTION with JSON-RPC error code 3 as permanent (BlockchainError)', () => {
      // JSON-RPC error code 3 definitively indicates execution revert (EIP-1474)
      // Even without revert data, this is a real contract revert
      const error = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        undefined, // No revert data
        { jsonRpcErrorCode: 3 }, // JSON-RPC error code 3 = execution reverted
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      // With JSON-RPC code 3, this SHOULD be a BlockchainError
      expect(e).to.be.instanceOf(BlockchainError);
      expect(e.isRecoverable).to.equal(false);
      expect(e.message).to.equal('execution reverted');
      expect(e.cause).to.equal(error);
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

    it('CALL_EXCEPTION without nested error stops trying additional providers', async () => {
      // CALL_EXCEPTION without nested error means ethers decode failure - permanent
      const callExceptionNoNestedError = new ProviderError(
        'call revert exception',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data from contract
        // No options = no nested error = decode failure
      );

      const provider1 = MockProvider.error(callExceptionNoNestedError);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError);
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.false; // Key test - second provider should NOT be called
      }
    });

    it('CALL_EXCEPTION with nested RPC error triggers fallback to next provider', async () => {
      // CALL_EXCEPTION with nested error but not code 3 is an RPC issue, should retry
      const callExceptionWithNestedError = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        '0x', // Empty data
        { hasNestedError: true }, // Has nested error but no code 3
      );

      const provider1 = MockProvider.error(callExceptionWithNestedError);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      const result = await provider.simplePerform('getBlockNumber', 1);

      // Should succeed from second provider
      expect(result).to.deep.equal('success2');
      expect(provider1.called).to.be.true;
      expect(provider1.thrownError).to.equal(callExceptionWithNestedError);
      expect(provider2.called).to.be.true; // Key test - second provider SHOULD be called
    });

    it('CALL_EXCEPTION with JSON-RPC error code 3 stops trying additional providers', async () => {
      // JSON-RPC error code 3 definitively indicates execution revert (EIP-1474)
      // Even without revert data, this should NOT trigger fallback
      const callExceptionJsonRpcCode3 = new ProviderError(
        'execution reverted',
        EthersError.CALL_EXCEPTION,
        undefined, // No revert data
        { jsonRpcErrorCode: 3 }, // JSON-RPC error code 3 = execution reverted
      );

      const provider1 = MockProvider.error(callExceptionJsonRpcCode3);
      const provider2 = MockProvider.success('success2');
      const provider = new TestableSmartProvider([provider1, provider2]);

      try {
        await provider.simplePerform('getBlockNumber', 1);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.instanceOf(BlockchainError);
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('execution reverted');
        expect(e.cause).to.equal(callExceptionJsonRpcCode3);
        expect(provider1.called).to.be.true;
        expect(provider1.thrownError).to.equal(callExceptionJsonRpcCode3);
        expect(provider2.called).to.be.false; // Key test - second provider should NOT be called
      }
    });
  });
});
