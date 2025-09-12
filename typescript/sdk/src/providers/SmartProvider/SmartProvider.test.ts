import { expect } from 'chai';
import { errors as EthersError, providers } from 'ethers';

import { AllProviderMethods, IProviderMethods } from './ProviderMethods.js';
import { HyperlaneSmartProvider } from './SmartProvider.js';
import { ProviderStatus } from './types.js';

// Dummy provider for testing
class DummyProvider extends providers.BaseProvider implements IProviderMethods {
  public readonly supportedMethods = AllProviderMethods;
  public called = false;

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

  async perform(method: string, params: any, _reqId?: number): Promise<any> {
    this.called = true;

    if (this.responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));
    }

    if (this.errorToThrow) {
      throw this.errorToThrow;
    }

    return this.successValue ?? { result: 'success', method, params };
  }

  // Required BaseProvider methods - minimal implementations
  async detectNetwork() {
    return { name: 'test', chainId: 1 };
  }
}

// Test subclass to expose protected methods for testing
class TestableSmartProvider extends HyperlaneSmartProvider {
  public testGetCombinedProviderError(
    errors: any[],
    fallbackMsg: string,
  ): new () => Error {
    return this.getCombinedProviderError(errors, fallbackMsg);
  }

  public async testPerformWithFallback(
    method: string,
    params: { [name: string]: any },
    providers: any[],
    reqId: number,
  ): Promise<any> {
    return this.performWithFallback(method, params, providers, reqId);
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
        const error = new Error(message);
        (error as any).code = code;
        (error as any).reason = message;

        try {
          const CombinedError = provider.testGetCombinedProviderError(
            [error],
            'Test fallback message',
          );
          throw new CombinedError();
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
        const CombinedError = provider.testGetCombinedProviderError(
          [error],
          'Test fallback message',
        );
        throw new CombinedError();
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
        const CombinedError = provider.testGetCombinedProviderError(
          [error],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e.name).to.equal('Error');
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(error);
      }
    });

    it('prioritizes BlockchainError when mixed with SERVER_ERROR', () => {
      const serverError = new Error('connection refused');
      (serverError as any).code = EthersError.SERVER_ERROR;

      const blockchainError = new Error('execution reverted');
      (blockchainError as any).code = EthersError.CALL_EXCEPTION;
      (blockchainError as any).reason = 'execution reverted';

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [serverError, blockchainError],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e.name).to.equal('BlockchainError');
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('execution reverted');
        expect(e.cause).to.equal(blockchainError);
      }
    });

    it('prioritizes BlockchainError when mixed with TIMEOUT', () => {
      const timeoutError = { status: ProviderStatus.Timeout };

      const blockchainError = new Error('insufficient funds');
      (blockchainError as any).code = EthersError.INSUFFICIENT_FUNDS;
      (blockchainError as any).reason = 'insufficient funds';

      try {
        const CombinedError = provider.testGetCombinedProviderError(
          [timeoutError, blockchainError],
          'Test fallback message',
        );
        throw new CombinedError();
      } catch (e: any) {
        expect(e.name).to.equal('BlockchainError');
        expect(e.isRecoverable).to.equal(false);
        expect(e.message).to.equal('insufficient funds');
        expect(e.cause).to.equal(blockchainError);
      }
    });
  });

  describe('performWithFallback', () => {
    it('returns success from first provider, second provider not called', async () => {
      const provider1 = new DummyProvider('http://provider1', undefined, {
        result: 'success1',
      });
      const provider2 = new DummyProvider('http://provider2', undefined, {
        result: 'success2',
      });

      const result = await provider.testPerformWithFallback(
        'getBlockNumber',
        {},
        [provider1, provider2],
        1,
      );

      expect(result).to.deep.equal({ result: 'success1' });
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.false;
    });

    it('calls second provider when first throws server error, returns success from second', async () => {
      const serverError = new Error('connection refused');
      (serverError as any).code = EthersError.SERVER_ERROR;

      const provider1 = new DummyProvider('http://provider1', serverError);
      const provider2 = new DummyProvider('http://provider2', undefined, {
        result: 'success2',
      });

      const result = await provider.testPerformWithFallback(
        'getBlockNumber',
        {},
        [provider1, provider2],
        1,
      );

      expect(result).to.deep.equal({ result: 'success2' });
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('calls second provider when first times out, returns success from second', async () => {
      // Create a SmartProvider with a short stagger delay for testing
      const testProvider = new TestableSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://localhost:8545' }],
        [],
        { fallbackStaggerMs: 50 }, // Short delay for testing
      );

      // Create a provider that will timeout by taking longer than stagger delay
      const provider1 = new DummyProvider(
        'http://provider1',
        undefined,
        { result: 'success1' },
        100,
      ); // 100ms delay > 50ms timeout
      const provider2 = new DummyProvider('http://provider2', undefined, {
        result: 'success2',
      });

      const result = await testProvider.testPerformWithFallback(
        'getBlockNumber',
        {},
        [provider1, provider2],
        1,
      );

      expect(result).to.deep.equal({ result: 'success2' });
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('both providers timeout, first provider ultimately returns result (waitForProviderSuccess)', async () => {
      // Create a SmartProvider with a short stagger delay for testing
      const testProvider = new TestableSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://localhost:8545' }],
        [],
        { fallbackStaggerMs: 50 }, // Short delay for testing
      );

      // Create two providers that both timeout initially but first eventually succeeds
      const provider1 = new DummyProvider(
        'http://provider1',
        undefined,
        { result: 'success1' },
        120,
      ); // 120ms delay
      const provider2 = new DummyProvider(
        'http://provider2',
        undefined,
        { result: 'success2' },
        200,
      ); // 200ms delay

      const result = await testProvider.testPerformWithFallback(
        'getBlockNumber',
        {},
        [provider1, provider2],
        1,
      );

      // First provider should win since it completes first
      expect(result).to.deep.equal({ result: 'success1' });
      expect(provider1.called).to.be.true;
      expect(provider2.called).to.be.true;
    });

    it('both providers throw errors, combined error is thrown', async () => {
      const serverError1 = new Error('connection refused 1');
      (serverError1 as any).code = EthersError.SERVER_ERROR;

      const serverError2 = new Error('connection refused 2');
      (serverError2 as any).code = EthersError.SERVER_ERROR;

      const provider1 = new DummyProvider('http://provider1', serverError1);
      const provider2 = new DummyProvider('http://provider2', serverError2);

      try {
        await provider.testPerformWithFallback(
          'getBlockNumber',
          {},
          [provider1, provider2],
          1,
        );
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e.name).to.equal('Error');
        expect(e.isRecoverable).to.be.undefined;
        expect(e.cause).to.equal(serverError1); // First error should be the cause
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.true;
      }
    });

    it('both providers timeout, combined timeout error is thrown', async () => {
      // Create a SmartProvider with a short stagger delay for testing
      const testProvider = new TestableSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://localhost:8545' }],
        [],
        { fallbackStaggerMs: 50 }, // Short delay for testing
      );

      // Create two providers that both take very long to respond
      const provider1 = new DummyProvider(
        'http://provider1',
        undefined,
        { result: 'success1' },
        2000,
      ); // 2s delay
      const provider2 = new DummyProvider(
        'http://provider2',
        undefined,
        { result: 'success2' },
        2000,
      ); // 2s delay

      try {
        await testProvider.testPerformWithFallback(
          'getBlockNumber',
          {},
          [provider1, provider2],
          1,
        );
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e.name).to.equal('Error');
        expect(e.isRecoverable).to.be.undefined;
        expect(e.message).to.include('All providers timed out');
        expect(provider1.called).to.be.true;
        expect(provider2.called).to.be.true;
      }
    });
  });
});
