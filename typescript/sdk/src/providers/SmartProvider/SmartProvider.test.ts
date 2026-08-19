import { expect } from 'chai';
import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import {
  AllProviderMethods,
  IProviderMethods,
  ProviderMethod,
} from './ProviderMethods.js';
import { HyperlaneEtherscanProvider } from './HyperlaneEtherscanProvider.js';
import {
  LogBlockHistoryUnavailableError,
  LogBlockRangeTooLargeError,
  type HyperlaneJsonRpcProvider,
} from './HyperlaneJsonRpcProvider.js';
import {
  BlockchainError,
  getSmartProviderErrorMessage,
  HyperlaneSmartProvider,
} from './SmartProvider.js';
import { ProviderStatus } from './types.js';
import { isMissingSelectorCallException } from '../../utils/contract.js';

// Dummy provider for testing
class MockProvider extends providers.BaseProvider implements IProviderMethods {
  public readonly supportedMethods = AllProviderMethods;
  public called = false;
  public callCount = 0;
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
    this.callCount += 1;

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

class RetrySpySmartProvider extends HyperlaneSmartProvider {
  public performWithFallbackCallCount = 0;

  constructor() {
    super({ chainId: 1, name: 'test' }, [{ http: 'http://provider' }], [], {
      maxRetries: 3,
      baseRetryDelayMs: 1,
      fallbackStaggerMs: 1,
    });
  }

  protected override async performWithFallback(
    _method: string,
    _params: { [name: string]: any },
    _providers: Array<HyperlaneEtherscanProvider | HyperlaneJsonRpcProvider>,
    _reqId: number,
  ): Promise<any> {
    this.performWithFallbackCallCount += 1;
    throw new ProviderError('connection refused', EthersError.SERVER_ERROR);
  }
}

class ProviderError extends Error {
  public readonly reason: string;
  public readonly code: string;
  public readonly data?: string;
  public readonly error?: {
    code?: string;
    message?: string;
    body?: string;
    error?: { code?: number; message?: string };
  };

  constructor(
    message: string,
    code: string,
    data?: string,
    options?: {
      jsonRpcErrorCode?: number;
      jsonRpcErrorMessage?: string;
      hasNestedError?: boolean;
      nestedBody?: string;
    },
  ) {
    super(message);
    this.reason = message;
    this.code = code;
    this.data = data;
    // Simulate ethers nested error structure for JSON-RPC errors
    if (options?.jsonRpcErrorCode !== undefined) {
      this.error = {
        error: {
          code: options.jsonRpcErrorCode,
          message: options.jsonRpcErrorMessage,
        },
      };
    } else if (options?.hasNestedError) {
      // Has nested error but no JSON-RPC code (e.g., RPC connection issue)
      this.error = { error: {}, body: options.nestedBody };
    }
    // If neither is set, error remains undefined (empty return decode failure)
  }
}

describe('SmartProvider', () => {
  let provider: TestableSmartProvider;

  beforeEach(() => {
    provider = new TestableSmartProvider([MockProvider.success('success')]);
  });

  describe('explorer getLogs pagination', () => {
    const address = '0x0000000000000000000000000000000000000001';
    const topic = `0x${'2'.repeat(64)}`;

    afterEach(() => sinon.restore());

    function rawLog(blockNumber: number) {
      return {
        address,
        blockHash: utils.hexZeroPad(utils.hexValue(blockNumber), 32),
        blockNumber: utils.hexValue(blockNumber),
        data: '0x',
        logIndex: '0x0',
        removed: false,
        topics: [topic],
        transactionHash: utils.hexZeroPad(utils.hexValue(blockNumber), 32),
        transactionIndex: '0x0',
      };
    }

    it('returns records past the first explorer page through a composite provider', async () => {
      const firstPage = Array.from({ length: 1_000 }, (_, index) =>
        rawLog(index + 1),
      );
      const secondPage = [rawLog(1_001)];
      const fetchStub = sinon
        .stub(HyperlaneEtherscanProvider.prototype, 'fetch')
        .onFirstCall()
        .resolves(firstPage)
        .onSecondCall()
        .resolves(secondPage);

      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider' }],
        [
          {
            name: 'test explorer',
            url: 'https://explorer.test',
            apiUrl: 'https://explorer.test/api',
          },
        ],
      );

      const logs = await smartProvider.getLogs({
        address,
        fromBlock: 1,
        toBlock: 2_000,
        topics: [topic],
      });

      expect(logs).to.have.length(1_001);
      expect(fetchStub.callCount).to.equal(2);
      expect(fetchStub.firstCall.args[1]).to.include({
        page: 1,
        offset: 1_000,
      });
      expect(fetchStub.secondCall.args[1]).to.include({
        page: 2,
        offset: 1_000,
      });
    });

    it('falls back to RPC rather than return an explorer page-ceiling prefix', async () => {
      const fullPage = Array.from({ length: 1_000 }, (_, index) =>
        rawLog(index + 1),
      );
      const fetchStub = sinon
        .stub(HyperlaneEtherscanProvider.prototype, 'fetch')
        .resolves(fullPage);
      const rpcLog = rawLog(2_000);
      const rpcPerform = sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(async (method: string) => {
          if (method === ProviderMethod.GetLogs) return [rpcLog];
          throw new Error(`Unexpected RPC method ${method}`);
        });

      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider' }],
        [
          {
            name: 'test explorer',
            url: 'https://explorer.test',
            apiUrl: 'https://explorer.test/api',
          },
        ],
      );

      const logs = await smartProvider.getLogs({
        address,
        fromBlock: 1,
        toBlock: 2_000,
        topics: [topic],
      });

      expect(fetchStub.callCount).to.equal(10);
      expect(rpcPerform.calledOnce).to.be.true;
      expect(logs).to.have.length(1);
      expect(logs[0].blockNumber).to.equal(2_000);
    });
  });

  describe('custom_rpc_header handling', () => {
    it('merges custom headers into existing connection and preserves fields', () => {
      const rawUrl =
        'http://example.com/path?custom_rpc_header=Authorization:token&foo=bar';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [
          {
            http: rawUrl,
            connection: {
              url: rawUrl,
              timeout: 1234,
              headers: { 'X-Test': 'abc' },
            },
          } as any,
        ],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;
      const expectedUrl = new URL('http://example.com/path?foo=bar').toString();

      expect(rpcConfig.http).to.equal(expectedUrl);
      expect(rpcConfig.connection?.url).to.equal(expectedUrl);
      expect(rpcConfig.connection?.timeout).to.equal(1234);
      expect(rpcConfig.connection?.headers).to.deep.equal({
        'X-Test': 'abc',
        Authorization: '[REDACTED]',
      });
    });

    it('preserves existing connection url when different and merges headers', () => {
      const rawUrl =
        'http://example.com/path?custom_rpc_header=Authorization:new';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [
          {
            http: rawUrl,
            connection: {
              url: 'http://other.example.com/path',
              timeout: 5678,
              headers: { Authorization: 'old', 'X-Test': 'abc' },
            },
          } as any,
        ],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;

      expect(rpcConfig.connection?.url).to.equal(
        'http://other.example.com/path',
      );
      expect(rpcConfig.connection?.timeout).to.equal(5678);
      expect(rpcConfig.connection?.headers).to.deep.equal({
        Authorization: '[REDACTED]',
        'X-Test': 'abc',
      });
    });

    it('handles multiple custom_rpc_header params', () => {
      const rawUrl =
        'http://example.com/path?custom_rpc_header=Authorization:Bearer%20token&custom_rpc_header=X-Api-Key:secret123';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: rawUrl }],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;

      expect(rpcConfig.http).to.equal('http://example.com/path');
      expect(rpcConfig.connection?.headers).to.deep.equal({
        Authorization: '[REDACTED]',
        'X-Api-Key': '[REDACTED]',
      });
    });

    it('silently skips malformed headers without colon', () => {
      const rawUrl =
        'http://example.com/path?custom_rpc_header=MalformedNoColon&custom_rpc_header=Valid:header';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: rawUrl }],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;

      expect(rpcConfig.http).to.equal('http://example.com/path');
      // Malformed header silently ignored, only valid one present
      expect(rpcConfig.connection?.headers).to.deep.equal({
        Valid: '[REDACTED]',
      });
    });

    it('passes through URL unchanged when no custom_rpc_header present', () => {
      const rawUrl = 'http://example.com/path?foo=bar&baz=qux';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: rawUrl }],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;

      expect(rpcConfig.http).to.equal(rawUrl);
      expect(rpcConfig.connection).to.be.undefined;
    });

    it('last duplicate header wins (like Rust behavior)', () => {
      const rawUrl =
        'http://example.com/path?custom_rpc_header=Authorization:first&custom_rpc_header=Authorization:second';
      const provider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: rawUrl }],
        [],
      );

      const rpcConfig = provider.rpcProviders[0].rpcConfig;
      // rpcConfig has redacted headers for logging safety
      expect(rpcConfig.connection?.headers?.['Authorization']).to.equal(
        '[REDACTED]',
      );

      // Actual connection (used for requests) has real value - last duplicate wins
      const actualConnection = provider.rpcProviders[0].connection;
      expect(actualConnection.headers?.['Authorization']).to.equal('second');
    });
  });

  describe('multi-address getLogs', () => {
    const addresses = [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ];
    const rawLog = {
      address: addresses[1],
      blockHash: `0x${'1'.repeat(64)}`,
      blockNumber: '0x2',
      data: '0x',
      logIndex: '0x0',
      topics: [`0x${'2'.repeat(64)}`],
      transactionHash: `0x${'3'.repeat(64)}`,
      transactionIndex: '0x0',
    };

    afterEach(() => sinon.restore());

    it('preserves retry, fallback, and formatted log behavior', async () => {
      const filters: providers.Filter[] = [];
      sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(async function (
          this: providers.JsonRpcProvider,
          method: string,
          params: { filter?: providers.Filter },
        ) {
          if (method !== ProviderMethod.GetLogs) {
            throw new Error(`Unexpected method ${method}`);
          }
          if (!params.filter) throw new Error('Missing log filter');
          filters.push(params.filter);
          if (this.connection.url === 'http://provider1') {
            throw new ProviderError('server error', EthersError.SERVER_ERROR);
          }
          return [rawLog];
        });
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider1' }, { http: 'http://provider2' }],
        [],
        { fallbackStaggerMs: 5 },
      );

      const logs = await smartProvider.getLogs({ address: addresses });

      expect(filters).to.have.length(2);
      expect(filters.map((filter) => filter.address)).to.deep.equal([
        addresses,
        addresses,
      ]);
      expect(logs).to.deep.equal([
        {
          ...rawLog,
          address: utils.getAddress(rawLog.address),
          blockNumber: 2,
          logIndex: 0,
          removed: false,
          transactionIndex: 0,
        },
      ]);
    });

    it('deterministically excludes explorer providers', async () => {
      const explorerPerform = sinon.stub(
        HyperlaneEtherscanProvider.prototype,
        'perform',
      );
      sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .withArgs(ProviderMethod.GetLogs)
        .resolves([]);
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider' }],
        [
          {
            name: 'test explorer',
            url: 'https://explorer.test',
            apiUrl: 'https://explorer.test/api',
          },
        ],
      );

      await smartProvider.getLogs({ address: addresses });

      expect(explorerPerform.called).to.be.false;
    });

    it('falls back from a slow primary without changing the filter', async () => {
      const requests: Array<{ url: string; filter: providers.Filter }> = [];
      sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(async function (
          this: providers.JsonRpcProvider,
          method: string,
          params: { filter: providers.Filter },
        ) {
          if (method !== ProviderMethod.GetLogs) {
            throw new Error(`Unexpected method ${method}`);
          }
          requests.push({ url: this.connection.url, filter: params.filter });
          if (this.connection.url === 'http://provider1') {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return [];
        });
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider1' }, { http: 'http://provider2' }],
        [],
        { fallbackStaggerMs: 1 },
      );

      await smartProvider.getLogs({ address: addresses });

      expect(requests.map(({ url }) => url)).to.deep.equal([
        'http://provider1',
        'http://provider2',
      ]);
      expect(requests.map(({ filter }) => filter.address)).to.deep.equal([
        addresses,
        addresses,
      ]);
    });

    it('retries the identical filter after a recoverable provider failure', async () => {
      const filters: providers.Filter[] = [];
      sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(
          async (method: string, params: { filter: providers.Filter }) => {
            if (method !== ProviderMethod.GetLogs) {
              throw new Error(`Unexpected method ${method}`);
            }
            filters.push(params.filter);
            if (filters.length === 1) {
              throw new ProviderError('server error', EthersError.SERVER_ERROR);
            }
            return [];
          },
        );
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider' }],
        [],
        { maxRetries: 2, baseRetryDelayMs: 1 },
      );

      await smartProvider.getLogs({ address: addresses });

      expect(filters).to.have.length(2);
      expect(filters.map((filter) => filter.address)).to.deep.equal([
        addresses,
        addresses,
      ]);
    });

    it('fails closed when only explorer providers are configured', async () => {
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [],
        [
          {
            name: 'test explorer',
            url: 'https://explorer.test',
            apiUrl: 'https://explorer.test/api',
          },
        ],
      );

      try {
        await smartProvider.getLogs({ address: addresses });
        expect.fail('Expected multi-address explorer request to fail');
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).to.equal(
          'No RPC providers available for multi-address getLogs',
        );
      }
    });

    it('rejects direct multi-address explorer requests', async () => {
      const explorerProvider = new HyperlaneEtherscanProvider(
        {
          name: 'test explorer',
          url: 'https://explorer.test',
          apiUrl: 'https://explorer.test/api',
          apiKey: 'test-key',
        },
        { chainId: 1, name: 'test' },
      );

      try {
        await explorerProvider.perform(ProviderMethod.GetLogs, {
          filter: { address: addresses },
        });
        expect.fail('Expected multi-address explorer request to fail');
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).to.equal(
          'Multi-address getLogs is not supported by explorer providers',
        );
      }
    });
  });

  describe('paginated getLogs failover', () => {
    const PAGINATED_LATEST_BLOCK = 20;

    afterEach(() => sinon.restore());

    function decodeWindow(filter: {
      fromBlock?: unknown;
      toBlock?: unknown;
    }): [number, number] {
      const { fromBlock, toBlock } = filter;
      assert(
        typeof fromBlock === 'string' && typeof toBlock === 'string',
        'Expected hex block bounds on the log filter',
      );
      return [
        BigNumber.from(fromBlock).toNumber(),
        BigNumber.from(toBlock).toNumber(),
      ];
    }

    // Each sub-query of a paginated getLogs goes through the same provider, so
    // one failing sub-query fails the whole call and the next provider has to
    // re-serve every window before the combined result is complete.
    it('re-serves every window from the next provider after a sub-query fails', async () => {
      const requests: Array<{ url: string; window: [number, number] }> = [];
      const logs = [12, 18].map((blockNumber) => ({
        address: '0x0000000000000000000000000000000000000001',
        blockHash: utils.hexZeroPad(utils.hexValue(blockNumber), 32),
        blockNumber: utils.hexValue(blockNumber),
        data: '0x',
        logIndex: '0x0',
        removed: false,
        topics: [`0x${'2'.repeat(64)}`],
        transactionHash: utils.hexZeroPad(utils.hexValue(blockNumber), 32),
        transactionIndex: '0x0',
      }));
      sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(async function (
          this: providers.JsonRpcProvider,
          method: string,
          params: { filter?: { fromBlock?: unknown; toBlock?: unknown } },
        ) {
          if (method === ProviderMethod.GetBlockNumber) {
            return PAGINATED_LATEST_BLOCK;
          }
          if (method !== ProviderMethod.GetLogs) {
            throw new Error(`Unexpected method ${method}`);
          }
          if (!params.filter) throw new Error('Missing log filter');
          const window = decodeWindow(params.filter);
          requests.push({ url: this.connection.url, window });
          if (this.connection.url === 'http://provider1') {
            throw new ProviderError('server error', EthersError.SERVER_ERROR);
          }
          return logs.filter((log) => {
            const blockNumber = BigNumber.from(log.blockNumber).toNumber();
            return blockNumber >= window[0] && blockNumber <= window[1];
          });
        });
      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [
          { http: 'http://provider1', pagination: { maxBlockRange: 5 } },
          { http: 'http://provider2', pagination: { maxBlockRange: 5 } },
        ],
        [],
      );

      const result = await smartProvider.getLogs({
        address: '0x0000000000000000000000000000000000000001',
        fromBlock: 11,
        toBlock: 20,
      });

      expect(requests).to.deep.equal([
        { url: 'http://provider1', window: [11, 15] },
        { url: 'http://provider1', window: [16, 20] },
        { url: 'http://provider2', window: [11, 15] },
        { url: 'http://provider2', window: [16, 20] },
      ]);
      expect(result.map((log) => log.blockNumber)).to.deep.equal([12, 18]);
    });
  });

  describe('Call "0x" failover', () => {
    let performStub: sinon.SinonStub;

    afterEach(() => {
      performStub?.restore();
    });

    it('fails over to a second RPC when the first returns "0x" for a call (transient/flaky node)', async () => {
      // Exercises the real HyperlaneJsonRpcProvider transport, not MockProvider:
      // a spurious empty "0x" from one provider must not be trusted as a final
      // answer when another provider returns real data (see #8792/#8910 — a
      // genuine empty response is only trustworthy once every configured RPC
      // agrees on it).
      performStub = sinon
        .stub(providers.JsonRpcProvider.prototype, 'perform')
        .callsFake(function (this: providers.JsonRpcProvider, method: string) {
          if (method !== 'call') return Promise.resolve('0x0');
          const isFirstProvider = this.connection.url === 'http://provider1';
          return Promise.resolve(isFirstProvider ? '0x' : '0x1234');
        });

      const smartProvider = new HyperlaneSmartProvider(
        { chainId: 1, name: 'test' },
        [{ http: 'http://provider1' }, { http: 'http://provider2' }],
        [],
      );

      const result = await smartProvider.call({
        to: '0x0000000000000000000000000000000000000001',
        data: '0x12345678',
      });

      expect(result).to.equal('0x1234');
    });
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

    it('ignores malformed errors when selecting SERVER_ERROR', () => {
      const error = new ProviderError(
        'connection refused',
        EthersError.SERVER_ERROR,
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [null, error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      expect(e.cause).to.equal(error);
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.SERVER_ERROR),
      );
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

    // A single provider refusing must not mark the combined error unretryable:
    // perform()'s retryAsync would stop at the first attempt and never ask the
    // provider whose failure was transient again.
    const nonRecoverableTestCases: Array<{
      name: string;
      errors: () => Error[];
      expectedIsRecoverable: false | undefined;
      expectedCauseIndex: number;
    }> = [
      {
        name: 'only one of two providers declared its failure unretryable',
        errors: () => [
          new LogBlockHistoryUnavailableError(
            'Requested block 100 is below the earliest block this RPC serves',
          ),
          new ProviderError('connection refused', EthersError.SERVER_ERROR),
        ],
        expectedIsRecoverable: undefined,
        expectedCauseIndex: 1,
      },
      {
        name: 'every provider declared its failure unretryable',
        errors: () => [
          new LogBlockHistoryUnavailableError(
            'Requested block 100 is below the earliest block this RPC serves',
          ),
          new LogBlockHistoryUnavailableError(
            'Requested block 100 is below the earliest block this RPC serves',
          ),
        ],
        expectedIsRecoverable: false,
        expectedCauseIndex: 0,
      },
      // Both orders of the same pair, because the cause is what
      // `isBlockRangeError` reads and only the range rejection is answerable by
      // a narrower request. Picking by provider order would have the same two
      // failures fail the read on one registry and complete it on another.
      {
        name: 'a range rejection was tried after a history floor',
        errors: () => [
          new LogBlockHistoryUnavailableError(
            'Requested block 100 is below the earliest block this RPC serves',
          ),
          new LogBlockRangeTooLargeError(
            'Serving blocks 100 to 200 needs 11 queries at a block range of 10',
          ),
        ],
        expectedIsRecoverable: false,
        expectedCauseIndex: 1,
      },
      {
        name: 'a range rejection was tried before a history floor',
        errors: () => [
          new LogBlockRangeTooLargeError(
            'Serving blocks 100 to 200 needs 11 queries at a block range of 10',
          ),
          new LogBlockHistoryUnavailableError(
            'Requested block 100 is below the earliest block this RPC serves',
          ),
        ],
        expectedIsRecoverable: false,
        expectedCauseIndex: 0,
      },
    ];

    nonRecoverableTestCases.forEach(
      ({ name, errors, expectedIsRecoverable, expectedCauseIndex }) => {
        it(`sets isRecoverable=${expectedIsRecoverable} when ${name}`, () => {
          const providerErrors = errors();
          const CombinedError = provider.testGetCombinedProviderError(
            providerErrors,
            'Test fallback message',
          );

          const e = new CombinedError();

          expect(e).to.not.be.instanceOf(BlockchainError);
          expect(Reflect.get(e, 'isRecoverable')).to.equal(
            expectedIsRecoverable,
          );
          expect(e.cause).to.equal(providerErrors[expectedCauseIndex]);
        });
      },
    );

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
      expect(e.message).to.equal(
        getSmartProviderErrorMessage(EthersError.CALL_EXCEPTION),
      );
    });

    it('surfaces nested provider message for CALL_EXCEPTION wrapping SERVER_ERROR body', () => {
      const error = new ProviderError(
        'missing revert data in call exception',
        EthersError.CALL_EXCEPTION,
        '0x',
        {
          hasNestedError: true,
          nestedBody: JSON.stringify({
            jsonrpc: '2.0',
            id: 331,
            error: { code: -32000, message: 'header not found' },
          }),
        },
      );
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e: any = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e).to.not.be.instanceOf(BlockchainError);
      expect(e.message).to.equal('header not found');
      expect(e.cause).to.equal(error);
    });

    it('preserves unhandled provider errors as causes', () => {
      const error = new Error('Invalid response from provider');
      const CombinedError = provider.testGetCombinedProviderError(
        [error],
        'Test fallback message',
      );

      const e = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e.cause).to.equal(error);
      expect(isMissingSelectorCallException(e)).to.equal(true);
    });

    it('uses the most diagnostic unhandled provider error as the cause', () => {
      const genericError = new Error('generic provider error');
      const emptyResponseError = new Error('Invalid response from provider');
      const CombinedError = provider.testGetCombinedProviderError(
        [genericError, emptyResponseError],
        'Test fallback message',
      );

      const e = new CombinedError();

      expect(e).to.be.instanceOf(Error);
      expect(e.cause).to.equal(emptyResponseError);
      expect(isMissingSelectorCallException(e)).to.equal(true);
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

    it('sendTransaction bypasses retryAsync to prevent duplicate submissions', async () => {
      const smartProvider = new RetrySpySmartProvider();

      // Call perform() (the public entry point) so the SendTransaction bypass in perform() is exercised.
      // RetrySpySmartProvider.performWithFallback always throws, so if retryAsync
      // were wrapping it, the call count would be > 1 (maxRetries=3).
      let threw = false;
      try {
        await smartProvider.perform(ProviderMethod.SendTransaction, {
          signedTransaction: '0x02',
        });
      } catch {
        threw = true;
      }
      expect(threw, 'perform should have thrown').to.be.true;
      // performWithFallback should be called exactly once (no retryAsync wrapping)
      expect(smartProvider.performWithFallbackCallCount).to.equal(1);
    });

    it('sendTransaction waits for provider instead of racing against timeout', async () => {
      // Provider responds slowly (longer than fallbackStaggerMs of 50ms)
      const provider1 = MockProvider.success('tx-hash', 200);
      const provider2 = MockProvider.success('tx-hash-2');
      const smartProvider = new TestableSmartProvider([provider1, provider2]);

      const result = await smartProvider.simplePerform(
        ProviderMethod.SendTransaction,
        1,
      );

      // Should wait for the slow provider instead of timing out and trying provider2
      expect(result).to.equal('tx-hash');
      expect(provider1.called).to.be.true;
      expect(provider1.callCount).to.equal(1);
      expect(provider2.called).to.be.false;
    });
  });
});
