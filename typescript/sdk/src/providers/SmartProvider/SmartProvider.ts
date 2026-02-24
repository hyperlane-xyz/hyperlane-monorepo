import { Logger, pino } from 'pino';
import { Hex, isHex, keccak256 } from 'viem';

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
import {
  type TypedDataTypesLike,
  getTypedDataPrimaryType,
} from '../../utils/typedData.js';
import type {
  EvmPopulatedTransaction,
  EvmProviderLike,
  EvmSignerLike,
  EvmTransactionReceiptLike,
  EvmTransactionResponseLike,
} from '../evmTypes.js';

type Networkish = number | string | { chainId: number; name?: string };
type SmartProviderSigner = EvmSignerLike & {
  address: string;
  provider: HyperlaneSmartProvider;
  signMessage(message: string | Uint8Array): Promise<string>;
  signTypedData(typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
  _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    value: Record<string, unknown>,
  ): Promise<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function getErrorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorReason(error: unknown): string | undefined {
  const reason = asRecord(error)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function getErrorData(error: unknown): unknown {
  return asRecord(error)?.data;
}

function getNestedError(error: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(error)?.error);
}

function getErrorMessage(error: unknown): string | undefined {
  const message = asRecord(error)?.message;
  return typeof message === 'string' ? message : undefined;
}

function isRpcBlockchainErrorCode(
  code: unknown,
): code is (typeof RPC_BLOCKCHAIN_ERRORS)[number] {
  return (
    typeof code === 'string' &&
    (RPC_BLOCKCHAIN_ERRORS as readonly string[]).includes(code)
  );
}

function isRpcServerErrorCode(
  code: unknown,
): code is (typeof RPC_SERVER_ERRORS)[number] {
  return (
    typeof code === 'string' &&
    (RPC_SERVER_ERRORS as readonly string[]).includes(code)
  );
}

function toErrorCause(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}

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
const DEFAULT_PRIORITY_FEE_WEI = 1_500_000_000n;

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
              this.network,
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
          this.network,
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

  async send<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (!this.rpcProviders.length)
      throw new Error('No RPC providers available');

    const errors: unknown[] = [];
    for (const [providerIndex, provider] of this.rpcProviders.entries()) {
      try {
        return (await provider.send(method, params)) as T;
      } catch (error) {
        errors.push(error);
        this.logger.debug(
          {
            chainId: this.network.chainId,
            error,
            method,
            providerIndex,
            rpcUrl: provider.getBaseUrl(),
          },
          'Error from provider while sending raw JSON-RPC method',
        );
      }
    }

    const CombinedError = this.getCombinedProviderError(
      errors,
      `All RPC providers failed on chain ${
        this.network.name
      } for method ${method} and params ${jsonStringifyForLogs(params, 2)}`,
    );
    throw new CombinedError();
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

  async getPriorityFee(): Promise<bigint> {
    try {
      const result = await this.perform(
        ProviderMethod.MaxPriorityFeePerGas,
        {},
      );
      return rpcHexToBigInt(result);
    } catch {
      return DEFAULT_PRIORITY_FEE_WEI;
    }
  }

  async getFeeData(): Promise<{
    gasPrice?: bigint;
    lastBaseFeePerGas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }> {
    const [block, gasPrice] = await Promise.all([
      this.getBlock('latest').catch(() => null),
      this.getGasPrice().catch(() => undefined),
    ]);

    const baseFeePerGas = rpcHexToBigIntOrUndefined(
      asRecord(block)?.baseFeePerGas,
    );
    if (baseFeePerGas === undefined) {
      return { gasPrice };
    }

    const maxPriorityFeePerGas = await this.getPriorityFee();
    return {
      gasPrice,
      lastBaseFeePerGas: baseFeePerGas,
      maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas,
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

  async getLogs(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return (await this.perform(ProviderMethod.GetLogs, {
      filter,
    })) as Record<string, unknown>[];
  }

  async getTransaction(
    transactionHash: string,
  ): Promise<Record<string, unknown> | null> {
    return (await this.perform(ProviderMethod.GetTransaction, {
      transactionHash,
    })) as Record<string, unknown> | null;
  }

  async getTransactionReceipt(
    transactionHash: string,
  ): Promise<EvmTransactionReceiptLike | null> {
    const result = (await this.perform(ProviderMethod.GetTransactionReceipt, {
      transactionHash,
    })) as EvmTransactionReceiptLike | null;
    if (!result) return null;
    const status = normalizeReceiptStatus(result.status);
    const transactionIndex = rpcHexToNumberOrUndefined(result.transactionIndex);
    const logs = Array.isArray(result.logs)
      ? result.logs.map(normalizeReceiptLog)
      : result.logs;
    return {
      ...result,
      blockNumber: rpcHexToNumber(result.blockNumber),
      ...(status !== undefined ? { status } : {}),
      ...(transactionIndex !== undefined ? { transactionIndex } : {}),
      ...(logs !== undefined ? { logs } : {}),
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
  ): Promise<EvmTransactionResponseLike> {
    let hash: string;
    try {
      hash = (await this.perform(ProviderMethod.SendTransaction, {
        signedTransaction,
      })) as string;
    } catch (error) {
      const recoveredHash = await this.recoverSentTransactionHash(
        error,
        signedTransaction,
      );
      if (!recoveredHash) throw error;
      hash = recoveredHash;
    }
    return {
      hash,
      wait: (confirmations = 1) =>
        this.waitForTransactionReceipt(hash, confirmations),
    };
  }

  protected async recoverSentTransactionHash(
    error: unknown,
    signedTransaction: string,
  ): Promise<string | null> {
    if (!isLikelyDuplicateBroadcastError(error)) {
      return null;
    }

    const recoveredHash =
      getTransactionHashFromSignedTransaction(signedTransaction);
    if (!recoveredHash) {
      return null;
    }

    const [receipt, tx] = await Promise.all([
      this.getTransactionReceipt(recoveredHash).catch(() => null),
      this.perform(ProviderMethod.GetTransaction, {
        transactionHash: recoveredHash,
      }).catch(() => null),
    ]);

    if (!receipt && !tx) {
      return null;
    }

    this.logger.debug(
      {
        chainId: this.network.chainId,
        error,
        transactionHash: recoveredHash,
      },
      'Recovered transaction hash after duplicate broadcast error',
    );
    return recoveredHash;
  }

  async waitForTransactionReceipt(
    hash: string,
    confirmations = 1,
    timeoutMs = 120_000,
  ): Promise<EvmTransactionReceiptLike> {
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

  getSigner(address: string): SmartProviderSigner {
    const signer: SmartProviderSigner = {
      address,
      provider: this,
      connect: (newProvider: EvmProviderLike) => {
        return newProvider.getSigner(address);
      },
      getAddress: async () => {
        return address;
      },
      getBalance: async () => {
        return this.getBalance(address);
      },
      estimateGas: async (tx: EvmPopulatedTransaction) => {
        return this.estimateGas({ ...tx, from: address });
      },
      sendTransaction: async (tx: EvmPopulatedTransaction) => {
        const hash = await this.send<string>('eth_sendTransaction', [
          normalizeRpcTx({ ...tx, from: address }),
        ]);
        return {
          hash,
          wait: (confirmations = 1) =>
            this.waitForTransactionReceipt(hash, confirmations),
        };
      },
      signMessage: async (message: string | Uint8Array) => {
        const data =
          typeof message === 'string'
            ? message.startsWith('0x')
              ? message
              : `0x${Buffer.from(message, 'utf8').toString('hex')}`
            : `0x${Buffer.from(message).toString('hex')}`;
        return this.send<string>('personal_sign', [data, address]);
      },
      signTypedData: async (typedData: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      }) => {
        const payload = jsonStringifyWithBigInt(typedData);
        return this.send<string>('eth_signTypedData_v4', [address, payload]);
      },
      _signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>,
      ) => {
        const primaryType = getTypedDataPrimaryType(
          types as TypedDataTypesLike,
        );
        return signer.signTypedData({
          domain,
          types,
          primaryType,
          message: value,
        });
      },
    };
    return signer;
  }

  async perform(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
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
    return this.explorerProviders.some((provider) => provider === p);
  }

  /**
   * This perform method has two phases:
   * 1. Sequentially triggers providers until success or blockchain error (permanent failure)
   * 2. Waits for any remaining pending provider promises to complete
   * TODO: Consider adding a quorum option that requires a certain number of providers to agree
   */
  protected async performWithFallback(
    method: string,
    params: Record<string, unknown>,
    providers: Array<HyperlaneEtherscanProvider | HyperlaneJsonRpcProvider>,
    reqId: number,
  ): Promise<unknown> {
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
        method: `${method}(${jsonStringifyForLogs(params)})`,
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
          const errorCode = getErrorCode(result.error);
          const revertData = getErrorData(result.error);
          const hasRevertData =
            typeof revertData === 'string' && revertData !== '0x';
          const nestedError = getNestedError(result.error);
          // JSON-RPC error code 3 definitively indicates execution revert (EIP-1474)
          // Check both nested levels as ethers wraps errors in error.error.code structure
          const jsonRpcErrorCode =
            asRecord(nestedError?.error)?.code ?? nestedError?.code;
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
            isRpcBlockchainErrorCode(errorCode) && !isCallExceptionWithoutData;

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
        } for method ${method} and params ${jsonStringifyForLogs(params, 2)}`,
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
          } for method ${method} and params ${jsonStringifyForLogs(params, 2)}`,
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
    params: Record<string, unknown>,
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
    errors: unknown[],
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
      const errorCode = getErrorCode(e);
      if (!isRpcBlockchainErrorCode(errorCode)) return false;
      if (errorCode !== EthersError.CALL_EXCEPTION) return true;
      // For CALL_EXCEPTION, check if it's a real revert or decode failure
      const revertData = getErrorData(e);
      const hasRevertData =
        typeof revertData === 'string' && revertData !== '0x';
      // Check for JSON-RPC error code 3 (nested in error.error.code by ethers)
      // Also check shallower level as error nesting varies
      const nestedError = getNestedError(e);
      const jsonRpcErrorCode =
        asRecord(nestedError?.error)?.code ?? nestedError?.code;
      const isJsonRpcRevert = jsonRpcErrorCode === 3;
      // No nested error means ethers failed to decode empty return data - permanent
      const isEmptyReturnDecodeFailure = !nestedError;
      return hasRevertData || isJsonRpcRevert || isEmptyReturnDecodeFailure;
    });

    const rpcServerError = errors.find((e) =>
      isRpcServerErrorCode(getErrorCode(e)),
    );

    const timedOutError = errors.find(
      (e) => asRecord(e)?.status === ProviderStatus.Timeout,
    );

    if (rpcBlockchainError) {
      // All blockchain errors are non-retryable and take priority
      return class extends BlockchainError {
        constructor() {
          super(
            getErrorReason(rpcBlockchainError) ??
              getErrorCode(rpcBlockchainError) ??
              fallbackMsg,
            {
              cause: toErrorCause(rpcBlockchainError),
            },
          );
        }
      };
    } else if (rpcServerError) {
      return class extends Error {
        constructor() {
          const serverMessage = getErrorMessage(getNestedError(rpcServerError));
          const serverCode = getErrorCode(rpcServerError);
          super(
            serverMessage ?? // Server errors sometimes will not have an error.message
              getSmartProviderErrorMessage(
                serverCode ?? EthersError.UNKNOWN_ERROR,
              ),
            { cause: toErrorCause(rpcServerError) },
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
            code: asRecord(e)?.code,
            message: asRecord(e)?.message,
            name: asRecord(e)?.name,
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
  return rpcHexToBigIntOrUndefined(value) ?? 0n;
}

function rpcHexToBigIntOrUndefined(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return BigInt(value);
    return BigInt(value || '0');
  }
  return undefined;
}

function rpcHexToNumber(value: unknown): number {
  return rpcHexToNumberOrUndefined(value) ?? 0;
}

function rpcHexToNumberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.startsWith('0x')) return Number(BigInt(value));
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeReceiptStatus(status: unknown): number | undefined {
  if (status === 'success') return 1;
  if (status === 'reverted') return 0;
  return rpcHexToNumberOrUndefined(status);
}

function normalizeReceiptLog(log: unknown): unknown {
  const parsed = asRecord(log);
  if (!parsed) return log;

  const blockNumber = rpcHexToNumberOrUndefined(parsed.blockNumber);
  const logIndex = rpcHexToNumberOrUndefined(parsed.logIndex);
  const transactionIndex = rpcHexToNumberOrUndefined(parsed.transactionIndex);

  return {
    ...parsed,
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(logIndex !== undefined ? { logIndex } : {}),
    ...(transactionIndex !== undefined ? { transactionIndex } : {}),
  };
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

function jsonStringifyForLogs(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, jsonStringifyBigIntReplacer, space);
  } catch {
    return '[unserializable]';
  }
}

function jsonStringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, jsonStringifyBigIntReplacer);
}

function jsonStringifyBigIntReplacer(_key: string, item: unknown) {
  if (typeof item === 'bigint') return item.toString();
  return item;
}

function isLikelyDuplicateBroadcastError(error: unknown): boolean {
  const messages = extractErrorMessages(error).map((m) => m.toLowerCase());
  return messages.some((message) =>
    [
      'nonce too low',
      'already known',
      'known transaction',
      'already imported',
    ].some((needle) => message.includes(needle)),
  );
}

function extractErrorMessages(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];

  const e = error as {
    message?: unknown;
    reason?: unknown;
    error?: { message?: unknown; error?: { message?: unknown } };
  };

  const messages = [
    e.message,
    e.reason,
    e.error?.message,
    e.error?.error?.message,
  ].filter((message): message is string => typeof message === 'string');

  return Array.from(new Set(messages));
}

function getTransactionHashFromSignedTransaction(
  signedTransaction: string,
): string | null {
  if (!isHex(signedTransaction)) return null;
  return keccak256(signedTransaction as Hex);
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
