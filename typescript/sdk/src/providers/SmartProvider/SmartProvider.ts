import { Logger, pino } from 'pino';

import {
  isObjEmpty,
  raceWithContext,
  retryAsync,
  rootLogger,
  runWithTimeout,
  sleep,
} from '@hyperlane-xyz/utils';

import {
  BlockExplorer,
  ChainMetadata,
  ExplorerFamily,
  RpcUrl,
} from '../../metadata/chainMetadataTypes.js';

import { HyperlaneEtherscanProvider } from './HyperlaneEtherscanProvider.js';
import { HyperlaneJsonRpcProvider } from './HyperlaneJsonRpcProvider.js';
import { IProviderMethods, ProviderMethod } from './ProviderMethods.js';
import {
  ChainMetadataWithRpcConnectionInfo,
  ConnectionInfo,
  ProviderPerformResult,
  ProviderStatus,
  ProviderTimeoutResult,
  RpcConfigWithConnectionInfo,
  SmartProviderOptions,
} from './types.js';
import { parseCustomRpcHeaders } from '../../utils/provider.js';

type Networkish = number | string | { chainId: number; name?: string };

function buildRpcConnections(
  rawUrl: string,
  existingConnection?: ConnectionInfo,
): {
  url: string;
  connection?: ConnectionInfo;
  redactedConnection?: ConnectionInfo;
} {
  const { url, headers, redactedHeaders } = parseCustomRpcHeaders(rawUrl);
  if (isObjEmpty(headers)) {
    return {
      url,
      connection: existingConnection,
      redactedConnection: existingConnection,
    };
  }

  const baseConnection = existingConnection ?? { url };
  const baseUrl = baseConnection.url === rawUrl ? url : baseConnection.url;
  const baseHeaders = baseConnection.headers ?? {};

  return {
    url,
    connection: {
      ...baseConnection,
      url: baseUrl,
      headers: {
        ...baseHeaders,
        ...headers,
      },
    },
    redactedConnection: {
      ...baseConnection,
      url: baseUrl,
      headers: {
        ...baseHeaders,
        ...redactedHeaders,
      },
    },
  };
}

export function getSmartProviderErrorMessage(errorMsg: string): string {
  return `${errorMsg}: RPC request failed. Check RPC validity. To override RPC URLs, see: https://docs.hyperlane.xyz/docs/deploy-hyperlane-troubleshooting#override-rpc-urls`;
}

const EthersError = {
  CALL_EXCEPTION: 'CALL_EXCEPTION',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  NONCE_EXPIRED: 'NONCE_EXPIRED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  REPLACEMENT_UNDERPRICED: 'REPLACEMENT_UNDERPRICED',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  TRANSACTION_REPLACED: 'TRANSACTION_REPLACED',
  UNPREDICTABLE_GAS_LIMIT: 'UNPREDICTABLE_GAS_LIMIT',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
} as const;

// This is a partial list. If needed, check the full list for more: https://docs.ethers.org/v5/api/utils/logger/#errors
const RPC_SERVER_ERRORS = [
  EthersError.SERVER_ERROR,
  EthersError.TIMEOUT,
  EthersError.UNKNOWN_ERROR,
];

const RPC_BLOCKCHAIN_ERRORS = [
  EthersError.CALL_EXCEPTION,
  EthersError.INSUFFICIENT_FUNDS,
  EthersError.INVALID_ARGUMENT, // Ethers decode failure (e.g., calling method on wrong contract type)
  EthersError.NETWORK_ERROR,
  EthersError.NONCE_EXPIRED,
  EthersError.NOT_IMPLEMENTED,
  EthersError.REPLACEMENT_UNDERPRICED,
  EthersError.TRANSACTION_REPLACED,
  EthersError.UNPREDICTABLE_GAS_LIMIT,
  EthersError.UNSUPPORTED_OPERATION,
];
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BASE_RETRY_DELAY_MS = 250; // 0.25 seconds
const DEFAULT_STAGGER_DELAY_MS = 1000; // 1 seconds
const DEFAULT_PHASE2_WAIT_MULTIPLIER = 20;

type HyperlaneProvider = HyperlaneEtherscanProvider | HyperlaneJsonRpcProvider;

export class BlockchainError extends Error {
  public readonly isRecoverable = false;

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
  }

  static {
    this.prototype.name = this.name;
  }
}

export class HyperlaneSmartProvider implements IProviderMethods {
  protected logger: Logger;

  // TODO also support blockscout here
  public readonly explorerProviders: HyperlaneEtherscanProvider[];
  public readonly rpcProviders: HyperlaneJsonRpcProvider[];
  public readonly supportedMethods: ProviderMethod[];
  public requestCount = 0;
  public readonly network: {
    chainId: number;
    name: string;
    ensAddress?: string;
  };

  constructor(
    network: Networkish,
    rpcUrls?: RpcUrl[],
    blockExplorers?: BlockExplorer[],
    public readonly options?: SmartProviderOptions,
  ) {
    this.network = normalizeNetworkish(network);
    const supportedMethods = new Set<ProviderMethod>();

    this.logger = rootLogger.child({
      module: `SmartProvider:${this.network.chainId}`,
    });

    if (!rpcUrls?.length && !blockExplorers?.length)
      throw new Error('At least one RPC URL or block explorer is required');

    if (blockExplorers?.length) {
      this.explorerProviders = blockExplorers
        .map((explorerConfig) => {
          if (
            !explorerConfig.family ||
            explorerConfig.family === ExplorerFamily.Etherscan
          ) {
            const newProvider = new HyperlaneEtherscanProvider(
              explorerConfig,
              network,
            );
            newProvider.supportedMethods.forEach((m) =>
              supportedMethods.add(m),
            );
            return newProvider;
            // TODO also support blockscout here
          } else return null;
        })
        .filter((e): e is HyperlaneEtherscanProvider => !!e);
    } else {
      this.explorerProviders = [];
    }

    if (rpcUrls?.length) {
      this.rpcProviders = rpcUrls.map((rpcConfig) => {
        const existingConnection = (rpcConfig as RpcConfigWithConnectionInfo)
          .connection;
        const { url, connection, redactedConnection } = buildRpcConnections(
          rpcConfig.http,
          existingConnection,
        );
        const configWithRedactedHeaders: RpcConfigWithConnectionInfo = {
          ...rpcConfig,
          http: url,
          connection: redactedConnection,
        };
        const newProvider = new HyperlaneJsonRpcProvider(
          configWithRedactedHeaders,
          network,
          undefined,
          connection,
        );
        newProvider.supportedMethods.forEach((m) => supportedMethods.add(m));
        return newProvider;
      });
    } else {
      this.rpcProviders = [];
    }

    this.supportedMethods = [...supportedMethods.values()];
  }

  setLogLevel(level: pino.LevelWithSilentOrString): void {
    this.logger.level = level;
  }

  static fromChainMetadata(
    chainMetadata: ChainMetadataWithRpcConnectionInfo,
    options?: SmartProviderOptions,
  ): HyperlaneSmartProvider {
    const network = chainMetadataToProviderNetwork(chainMetadata);
    return new HyperlaneSmartProvider(
      network,
      chainMetadata.rpcUrls,
      chainMetadata.blockExplorers,
      options,
    );
  }

  static fromRpcUrl(
    network: Networkish,
    rpcUrl: string,
    options?: SmartProviderOptions,
  ): HyperlaneSmartProvider {
    return new HyperlaneSmartProvider(
      network,
      [{ http: rpcUrl }],
      undefined,
      options,
    );
  }

  async detectNetwork(): Promise<{ chainId: number; name: string }> {
    // For simplicity, efficiency, and better compat with new networks, this assumes
    // the provided RPC urls are correct and returns static data here instead of
    // querying each sub-provider for network info
    return this.network;
  }

  async getNetwork(): Promise<{ chainId: number; name: string }> {
    return this.detectNetwork();
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    const provider = this.rpcProviders[0];
    if (!provider) throw new Error('No RPC providers available');
    return provider.send(method, params);
  }

  async getBlockNumber(): Promise<number> {
    const result = await this.perform(ProviderMethod.GetBlockNumber, {});
    return rpcHexToNumber(result);
  }

  async getBlock(
    blockTag: string | number = 'latest',
  ): Promise<Record<string, unknown> & { number: number }> {
    const result = (await this.perform(ProviderMethod.GetBlock, {
      blockTag,
      includeTransactions: false,
    })) as Record<string, unknown> | null;
    if (!result) throw new Error(`Block ${String(blockTag)} not found`);
    const number = rpcHexToNumber(result.number);
    return {
      ...result,
      number,
    };
  }

  async getBalance(
    address: string,
    blockTag: string | number = 'latest',
  ): Promise<bigint> {
    const result = await this.perform(ProviderMethod.GetBalance, {
      address,
      blockTag,
    });
    return rpcHexToBigInt(result);
  }

  async getGasPrice(): Promise<bigint> {
    const result = await this.perform(ProviderMethod.GetGasPrice, {});
    return rpcHexToBigInt(result);
  }

  async getFeeData(): Promise<{
    gasPrice: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
    const [gasPrice, maxPriorityFeePerGas] = await Promise.all([
      this.getGasPrice(),
      this.perform(ProviderMethod.MaxPriorityFeePerGas, {}).then(
        rpcHexToBigInt,
      ),
    ]);
    return {
      gasPrice,
      maxFeePerGas: gasPrice + maxPriorityFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  async getCode(
    address: string,
    blockTag: string | number = 'latest',
  ): Promise<string> {
    return (await this.perform(ProviderMethod.GetCode, {
      address,
      blockTag,
    })) as string;
  }

  async getStorageAt(
    address: string,
    position: string,
    blockTag: string | number = 'latest',
  ): Promise<string> {
    return (await this.perform(ProviderMethod.GetStorageAt, {
      address,
      position,
      blockTag,
    })) as string;
  }

  async getTransactionCount(
    address: string,
    blockTag: string | number = 'latest',
  ): Promise<number> {
    const result = await this.perform(ProviderMethod.GetTransactionCount, {
      address,
      blockTag,
    });
    return rpcHexToNumber(result);
  }

  async getLogs(filter: Record<string, unknown>): Promise<unknown[]> {
    return (await this.perform(ProviderMethod.GetLogs, {
      filter,
    })) as unknown[];
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<Record<string, unknown> | null> {
    const result = (await this.perform(ProviderMethod.GetTransactionReceipt, {
      transactionHash,
    })) as Record<string, unknown> | null;
    if (!result) return null;
    return {
      ...result,
      blockNumber: rpcHexToNumber(result.blockNumber),
    };
  }

  async estimateGas(transaction: Record<string, unknown>): Promise<bigint> {
    const result = await this.perform(ProviderMethod.EstimateGas, {
      transaction,
    });
    return rpcHexToBigInt(result);
  }

  async call(
    transaction: Record<string, unknown>,
    blockTag: string | number = 'latest',
  ): Promise<string> {
    return (await this.perform(ProviderMethod.Call, {
      transaction,
      blockTag,
    })) as string;
  }

  async sendTransaction(
    signedTransaction: string,
  ): Promise<{ hash: string; wait(confirmations?: number): Promise<unknown> }> {
    const hash = (await this.perform(ProviderMethod.SendTransaction, {
      signedTransaction,
    })) as string;
    return {
      hash,
      wait: (confirmations = 1) =>
        this.waitForTransactionReceipt(hash, confirmations),
    };
  }

  async waitForTransactionReceipt(
    hash: string,
    confirmations = 1,
    timeoutMs = 120_000,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    let receipt = await this.getTransactionReceipt(hash);
    while (!receipt) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timeout waiting for transaction ${hash}`);
      }
      await sleep(500);
      receipt = await this.getTransactionReceipt(hash);
    }
    if (confirmations <= 1) return receipt;

    const txBlockNumber = rpcHexToNumber(receipt.blockNumber);
    while (Date.now() - started <= timeoutMs) {
      const latestBlock = await this.getBlock('latest');
      if (latestBlock.number >= txBlockNumber + confirmations - 1) {
        return (await this.getTransactionReceipt(hash)) || receipt;
      }
      await sleep(500);
    }
    throw new Error(
      `Timeout waiting for ${confirmations} confirmations for transaction ${hash}`,
    );
  }

  getSigner(address: string): {
    address: string;
    provider: HyperlaneSmartProvider;
    connect(
      provider: HyperlaneSmartProvider,
    ): ReturnType<HyperlaneSmartProvider['getSigner']>;
    getAddress(): Promise<string>;
    estimateGas(tx: Record<string, unknown>): Promise<bigint>;
    sendTransaction(tx: Record<string, unknown>): Promise<{
      hash: string;
      wait(confirmations?: number): Promise<unknown>;
    }>;
    signMessage(message: string | Uint8Array): Promise<string>;
  } {
    const provider = this;
    const signer = {
      address,
      provider,
      connect(newProvider: HyperlaneSmartProvider) {
        return newProvider.getSigner(address);
      },
      async getAddress() {
        return address;
      },
      async estimateGas(tx: Record<string, unknown>) {
        return provider.estimateGas({ ...tx, from: address });
      },
      async sendTransaction(tx: Record<string, unknown>) {
        const hash = (await provider.send('eth_sendTransaction', [
          normalizeRpcTx({ ...tx, from: address }),
        ])) as string;
        return {
          hash,
          wait: (confirmations = 1) =>
            provider.waitForTransactionReceipt(hash, confirmations),
        };
      },
      async signMessage(message: string | Uint8Array) {
        const data =
          typeof message === 'string'
            ? message.startsWith('0x')
              ? message
              : `0x${Buffer.from(message, 'utf8').toString('hex')}`
            : `0x${Buffer.from(message).toString('hex')}`;
        return provider.send('personal_sign', [
          data,
          address,
        ]) as Promise<string>;
      },
    };
    return signer;
  }

  async perform(method: string, params: { [name: string]: any }): Promise<any> {
    const allProviders = [...this.explorerProviders, ...this.rpcProviders];
    if (!allProviders.length) throw new Error('No providers available');

    const supportedProviders = allProviders.filter((p) =>
      p.supportedMethods.includes(method as ProviderMethod),
    );
    if (!supportedProviders.length)
      throw new Error(`No providers available for method ${method}`);

    this.requestCount += 1;
    const reqId = this.requestCount;

    return retryAsync(
      () => this.performWithFallback(method, params, supportedProviders, reqId),
      this.options?.maxRetries || DEFAULT_MAX_RETRIES,
      this.options?.baseRetryDelayMs || DEFAULT_BASE_RETRY_DELAY_MS,
    );
  }

  /**
   * Checks if this SmartProvider is healthy by checking for new blocks
   * @param numBlocks The number of sequential blocks to check for. Default 1
   * @param timeoutMs The maximum time to wait for the full check. Default 3000ms
   * @returns true if the provider is healthy, false otherwise
   */
  async isHealthy(numBlocks = 1, timeoutMs = 3_000): Promise<boolean> {
    try {
      await runWithTimeout(timeoutMs, async () => {
        let previousBlockNumber = 0;
        let i = 1;
        while (i <= numBlocks) {
          const block = await this.getBlock('latest');
          if (block.number > previousBlockNumber) {
            i += 1;
            previousBlockNumber = block.number;
          } else {
            await sleep(500);
          }
        }
        return true;
      });
      return true;
    } catch (error) {
      this.logger.error('Provider is unhealthy', error);
      return false;
    }
  }

  isExplorerProvider(p: HyperlaneProvider): p is HyperlaneEtherscanProvider {
    return this.explorerProviders.includes(p as any);
  }

  /**
   * This perform method has two phases:
   * 1. Sequentially triggers providers until success or blockchain error (permanent failure)
   * 2. Waits for any remaining pending provider promises to complete
   * TODO: Consider adding a quorum option that requires a certain number of providers to agree
   */
  protected async performWithFallback(
    method: string,
    params: { [name: string]: any },
    providers: Array<HyperlaneEtherscanProvider | HyperlaneJsonRpcProvider>,
    reqId: number,
  ): Promise<any> {
    let pIndex = 0;
    const providerResultPromises: Promise<ProviderPerformResult>[] = [];
    const providerResultErrors: unknown[] = [];

    // Phase 1: Trigger providers sequentially until success or blockchain error
    providerLoop: while (pIndex < providers.length) {
      const provider = providers[pIndex];
      const isLastProvider = pIndex === providers.length - 1;

      // Skip the explorer provider if it's currently in a cooldown period
      if (
        this.isExplorerProvider(provider) &&
        provider.getQueryWaitTime() > 0 &&
        !isLastProvider &&
        method !== ProviderMethod.GetLogs // never skip GetLogs
      ) {
        pIndex += 1;
        continue;
      }

      const resultPromise = this.wrapProviderPerform(
        provider,
        pIndex,
        method,
        params,
        reqId,
      );
      const timeoutPromise = timeoutResult(
        this.options?.fallbackStaggerMs || DEFAULT_STAGGER_DELAY_MS,
      );
      const result = await Promise.race([resultPromise, timeoutPromise]);

      const providerMetadata = {
        providerIndex: pIndex,
        rpcUrl: provider.getBaseUrl(),
        method: `${method}(${JSON.stringify(params)})`,
        chainId: this.network.chainId,
      };

      switch (result.status) {
        case ProviderStatus.Success:
          return result.value;
        case ProviderStatus.Timeout:
          this.logger.debug(
            { ...providerMetadata },
            `Slow response from provider:`,
            isLastProvider ? '' : 'Triggering next provider.',
          );
          providerResultPromises.push(resultPromise);
          pIndex += 1;
          break;
        case ProviderStatus.Error: {
          providerResultErrors.push(result.error);
          // If this is a blockchain error, stop trying additional providers as it's a permanent failure
          // For CALL_EXCEPTION, we need to distinguish:
          // 1. Real revert with data - permanent (has revert data like "0x08c379a0...")
          // 2. Real revert without data - permanent (has nested error.error.code === 3 from JSON-RPC)
          // 3. Empty return data decode failure - permanent (no nested error, ethers failed to decode "0x")
          // 4. Actual RPC issue - transient (has nested error but not code 3)
          const errorCode = (result.error as any)?.code;
          const revertData = (result.error as any)?.data;
          const hasRevertData = !!revertData && revertData !== '0x';
          const nestedError = (result.error as any)?.error;
          // JSON-RPC error code 3 definitively indicates execution revert (EIP-1474)
          // Check both nested levels as ethers wraps errors in error.error.code structure
          const jsonRpcErrorCode =
            nestedError?.error?.code ?? nestedError?.code;
          const isJsonRpcRevert = jsonRpcErrorCode === 3;
          // No nested error means ethers failed to decode empty return data - this is permanent
          const isEmptyReturnDecodeFailure =
            errorCode === EthersError.CALL_EXCEPTION &&
            !hasRevertData &&
            !nestedError;
          const isCallExceptionWithoutData =
            errorCode === EthersError.CALL_EXCEPTION &&
            !hasRevertData &&
            !isJsonRpcRevert &&
            !isEmptyReturnDecodeFailure;
          const isPermanentBlockchainError =
            RPC_BLOCKCHAIN_ERRORS.includes(errorCode) &&
            !isCallExceptionWithoutData;

          if (isPermanentBlockchainError) {
            this.logger.debug(
              { ...providerMetadata },
              `${errorCode} detected - stopping provider fallback as this is a permanent failure`,
            );
            break providerLoop;
          }
          if (isCallExceptionWithoutData) {
            this.logger.debug(
              { ...providerMetadata },
              `${errorCode} without revert data detected - treating as transient RPC error, will retry`,
            );
          }
          this.logger.debug(
            {
              error: result.error,
              ...providerMetadata,
            },
            `Error from provider.`,
            isLastProvider ? '' : 'Triggering next provider.',
          );
          pIndex += 1;
          break;
        }
        default:
          throw new Error(
            `Unexpected result from provider: ${JSON.stringify(
              providerMetadata,
            )}`,
          );
      }
    }

    // Phase 2: All providers already triggered, wait for one to complete or all to fail/timeout
    // If no providers are left, all have already failed
    if (providerResultPromises.length === 0) {
      const CombinedError = this.getCombinedProviderError(
        providerResultErrors,
        `All providers failed on chain ${
          this.network.name
        } for method ${method} and params ${JSON.stringify(params, null, 2)}`,
      );
      throw new CombinedError();
    }

    // Wait for at least one provider to succeed or all to fail/timeout
    const timeoutPromise = timeoutResult(
      this.options?.fallbackStaggerMs || DEFAULT_STAGGER_DELAY_MS,
      DEFAULT_PHASE2_WAIT_MULTIPLIER,
    );
    const resultPromise = this.waitForProviderSuccess(providerResultPromises);
    const result = await Promise.race([resultPromise, timeoutPromise]);

    switch (result.status) {
      case ProviderStatus.Success:
        return result.value;
      case ProviderStatus.Timeout: {
        const CombinedError = this.getCombinedProviderError(
          [result, ...providerResultErrors],
          `All providers timed out on chain ${this.network.name} for method ${method}`,
        );
        throw new CombinedError();
      }
      case ProviderStatus.Error: {
        const CombinedError = this.getCombinedProviderError(
          [result.error, ...providerResultErrors],
          `All providers failed on chain ${
            this.network.name
          } for method ${method} and params ${JSON.stringify(params, null, 2)}`,
        );
        throw new CombinedError();
      }
      default:
        throw new Error('Unexpected result from provider');
    }
  }

  // Wrap for additional logging and error handling
  protected async wrapProviderPerform(
    provider: HyperlaneProvider,
    pIndex: number,
    method: string,
    params: any,
    reqId: number,
  ): Promise<ProviderPerformResult> {
    try {
      if (this.options?.debug)
        this.logger.debug(
          `Provider #${pIndex} performing method ${method} for reqId ${reqId}`,
        );
      const result = await provider.perform(method, params, reqId);
      return { status: ProviderStatus.Success, value: result };
    } catch (error) {
      if (this.options?.debug)
        this.logger.error(
          `Error performing ${method} on provider #${pIndex} for reqId ${reqId}`,
          error,
        );
      return { status: ProviderStatus.Error, error };
    }
  }

  // Returns the first success from a list a promises, or an error if all fail
  protected async waitForProviderSuccess(
    resultPromises: Promise<ProviderPerformResult>[],
  ): Promise<ProviderPerformResult> {
    const combinedErrors: unknown[] = [];
    const resolvedPromises = new Set<Promise<ProviderPerformResult>>();
    while (resolvedPromises.size < resultPromises.length) {
      const unresolvedPromises = resultPromises.filter(
        (p) => !resolvedPromises.has(p),
      );
      const winner = await raceWithContext(unresolvedPromises);
      resolvedPromises.add(winner.promise);
      const result = winner.resolved;
      if (result.status === ProviderStatus.Success) {
        return result;
      } else if (result.status === ProviderStatus.Error) {
        combinedErrors.push(result.error);
      } else {
        return {
          status: ProviderStatus.Error,
          error: new Error('Unexpected result format from provider'),
        };
      }
    }
    // If reached, all providers finished unsuccessfully
    return {
      status: ProviderStatus.Error,
      // TODO combine errors
      error: combinedErrors.length
        ? combinedErrors[0]
        : new Error('Unknown error from provider'),
    };
  }

  protected getCombinedProviderError(
    errors: any[],
    fallbackMsg: string,
  ): new () => Error {
    this.logger.debug(fallbackMsg);
    if (errors.length === 0) {
      return class extends Error {
        constructor() {
          super(fallbackMsg);
        }
      };
    }

    // Find blockchain errors, but exclude CALL_EXCEPTION without revert data (likely RPC issues)
    // Note: ethers sets data to "0x" when there's no actual revert data
    // However, JSON-RPC error code 3 definitively indicates a contract revert (EIP-1474)
    // Also, no nested error means ethers failed to decode empty return data - also permanent
    const rpcBlockchainError = errors.find((e) => {
      if (!RPC_BLOCKCHAIN_ERRORS.includes(e.code)) return false;
      if (e.code !== EthersError.CALL_EXCEPTION) return true;
      // For CALL_EXCEPTION, check if it's a real revert or decode failure
      const hasRevertData = !!e.data && e.data !== '0x';
      // Check for JSON-RPC error code 3 (nested in error.error.code by ethers)
      // Also check shallower level as error nesting varies
      const jsonRpcErrorCode = e.error?.error?.code ?? e.error?.code;
      const isJsonRpcRevert = jsonRpcErrorCode === 3;
      // No nested error means ethers failed to decode empty return data - permanent
      const isEmptyReturnDecodeFailure = !e.error;
      return hasRevertData || isJsonRpcRevert || isEmptyReturnDecodeFailure;
    });

    const rpcServerError = errors.find((e) =>
      RPC_SERVER_ERRORS.includes(e.code),
    );

    const timedOutError = errors.find(
      (e) => e.status === ProviderStatus.Timeout,
    );

    if (rpcBlockchainError) {
      // All blockchain errors are non-retryable and take priority
      return class extends BlockchainError {
        constructor() {
          super(rpcBlockchainError.reason ?? rpcBlockchainError.code, {
            cause: rpcBlockchainError,
          });
        }
      };
    } else if (rpcServerError) {
      return class extends Error {
        constructor() {
          super(
            rpcServerError.error?.message ?? // Server errors sometimes will not have an error.message
              getSmartProviderErrorMessage(rpcServerError.code),
            { cause: rpcServerError },
          );
        }
      };
    } else if (timedOutError) {
      return class extends Error {
        constructor() {
          super(fallbackMsg, {
            cause: timedOutError,
          });
        }
      };
    } else {
      this.logger.warn(
        {
          errors: errors.map((e) => ({
            code: e?.code,
            message: e?.message,
            name: e?.name,
          })),
        },
        'Unhandled error case in combined provider error handler',
      );
      return class extends Error {
        constructor() {
          super(fallbackMsg);
        }
      };
    }
  }
}

function chainMetadataToProviderNetwork(
  chainMetadata: ChainMetadata | ChainMetadataWithRpcConnectionInfo,
): { chainId: number; name: string; ensAddress?: string } {
  return {
    name: chainMetadata.name,
    chainId: chainMetadata.chainId as number,
    // @ts-ignore add ensAddress to ChainMetadata
    ensAddress: chainMetadata.ensAddress,
  };
}

function normalizeNetworkish(network: Networkish): {
  chainId: number;
  name: string;
  ensAddress?: string;
} {
  if (typeof network === 'number') {
    return { chainId: network, name: String(network) };
  }
  if (typeof network === 'string') {
    const chainId = Number(network);
    return {
      chainId: Number.isFinite(chainId) ? chainId : 0,
      name: network,
    };
  }
  return {
    chainId: network.chainId,
    name: network.name || String(network.chainId),
  };
}

function rpcHexToBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return BigInt(value);
    return BigInt(value || '0');
  }
  return 0n;
}

function rpcHexToNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return Number(BigInt(value));
    return Number(value || 0);
  }
  return 0;
}

function normalizeRpcTx(tx: Record<string, unknown>): Record<string, unknown> {
  const request = { ...tx };
  const normalized: Record<string, unknown> = {
    ...request,
    gas: toRpcQuantity(request.gas ?? request.gasLimit),
    gasPrice: toRpcQuantity(request.gasPrice),
    maxFeePerGas: toRpcQuantity(request.maxFeePerGas),
    maxPriorityFeePerGas: toRpcQuantity(request.maxPriorityFeePerGas),
    nonce: toRpcQuantity(request.nonce),
    value: toRpcQuantity(request.value),
  };
  if (!normalized.gas) delete normalized.gas;
  if (!normalized.gasPrice) delete normalized.gasPrice;
  if (!normalized.maxFeePerGas) delete normalized.maxFeePerGas;
  if (!normalized.maxPriorityFeePerGas) delete normalized.maxPriorityFeePerGas;
  if (!normalized.nonce) delete normalized.nonce;
  if (!normalized.value) delete normalized.value;
  return normalized;
}

function toRpcQuantity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return value;
    return `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value === 'object' && value && 'toString' in value) {
    return `0x${BigInt(value.toString()).toString(16)}`;
  }
  return undefined;
}

function timeoutResult(staggerDelay: number, multiplier = 1) {
  return new Promise<ProviderTimeoutResult>((resolve) =>
    setTimeout(
      () =>
        resolve({
          status: ProviderStatus.Timeout,
        }),
      staggerDelay * multiplier,
    ),
  );
}
