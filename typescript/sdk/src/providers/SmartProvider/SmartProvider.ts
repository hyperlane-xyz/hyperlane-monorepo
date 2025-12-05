import { BigNumber, errors as EthersError, providers, utils } from 'ethers';
import { Logger, pino } from 'pino';

import {
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
  extractEthersErrorContext,
  formatEthersErrorContext,
  formatRpcCall,
} from './RpcCallFormatting.js';
import {
  ChainMetadataWithRpcConnectionInfo,
  ProviderPerformResult,
  ProviderStatus,
  ProviderTimeoutResult,
  SmartProviderOptions,
} from './types.js';

/**
 * Information about a failed provider attempt for error reporting
 */
interface FailedProviderInfo {
  providerUrl: string;
  error: unknown;
}

export function getSmartProviderErrorMessage(errorMsg: string): string {
  return `${errorMsg}: RPC request failed. Check RPC validity. To override RPC URLs, see: https://docs.hyperlane.xyz/docs/deploy-hyperlane-troubleshooting#override-rpc-urls`;
}

// This is a partial list. If needed, check the full list for more: https://docs.ethers.org/v5/api/utils/logger/#errors
const RPC_SERVER_ERRORS = [
  EthersError.SERVER_ERROR,
  EthersError.TIMEOUT,
  EthersError.UNKNOWN_ERROR,
];

const RPC_BLOCKCHAIN_ERRORS = [
  EthersError.CALL_EXCEPTION,
  EthersError.INSUFFICIENT_FUNDS,
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

export class HyperlaneSmartProvider
  extends providers.BaseProvider
  implements IProviderMethods
{
  protected logger: Logger;

  // TODO also support blockscout here
  public readonly explorerProviders: HyperlaneEtherscanProvider[];
  public readonly rpcProviders: HyperlaneJsonRpcProvider[];
  public readonly supportedMethods: ProviderMethod[];
  public requestCount = 0;

  constructor(
    network: providers.Networkish,
    rpcUrls?: RpcUrl[],
    blockExplorers?: BlockExplorer[],
    public readonly options?: SmartProviderOptions,
  ) {
    super(network);
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
        const newProvider = new HyperlaneJsonRpcProvider(rpcConfig, network);
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

  async getPriorityFee(): Promise<BigNumber> {
    try {
      return BigNumber.from(await this.perform('maxPriorityFeePerGas', {}));
    } catch {
      return BigNumber.from('1500000000');
    }
  }

  async getFeeData(): Promise<providers.FeeData> {
    // override hardcoded getFeedata
    // Copied from https://github.com/ethers-io/ethers.js/blob/v5/packages/abstract-provider/src.ts/index.ts#L235 which SmartProvider inherits this logic from
    const { block, gasPrice } = await utils.resolveProperties({
      block: this.getBlock('latest'),
      gasPrice: this.getGasPrice().catch(() => {
        return null;
      }),
    });

    let lastBaseFeePerGas: BigNumber | null = null,
      maxFeePerGas: BigNumber | null = null,
      maxPriorityFeePerGas: BigNumber | null = null;

    if (block?.baseFeePerGas) {
      // We may want to compute this more accurately in the future,
      // using the formula "check if the base fee is correct".
      // See: https://eips.ethereum.org/EIPS/eip-1559
      lastBaseFeePerGas = block.baseFeePerGas;
      maxPriorityFeePerGas = await this.getPriorityFee();
      maxFeePerGas = block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas);
    }

    return { lastBaseFeePerGas, maxFeePerGas, maxPriorityFeePerGas, gasPrice };
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
    network: providers.Networkish,
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

  async detectNetwork(): Promise<providers.Network> {
    // For simplicity, efficiency, and better compat with new networks, this assumes
    // the provided RPC urls are correct and returns static data here instead of
    // querying each sub-provider for network info
    return this.network;
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
   * Gets a human-readable chain identifier for error messages.
   * Falls back to chainId if name is not available.
   */
  protected getChainIdentifier(): string {
    const name = this.network.name;
    const chainId = this.network.chainId;
    // Check if name is meaningful (not undefined, not 'unknown', not just the chainId as string)
    if (name && name !== 'unknown' && name !== String(chainId)) {
      return `${name} (${chainId})`;
    }
    return `chainId: ${chainId}`;
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
    const failedProviders: FailedProviderInfo[] = [];

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

      const rpcCall = formatRpcCall(method, params);
      const providerMetadata = {
        providerIndex: pIndex,
        rpcUrl: provider.getBaseUrl(),
        rpcCall,
        chain: this.network.name,
        chainId: this.network.chainId,
      };

      switch (result.status) {
        case ProviderStatus.Success:
          return result.value;
        case ProviderStatus.Timeout:
          this.logger.debug(
            { ...providerMetadata },
            `Slow response from provider for ${rpcCall}.`,
            isLastProvider ? '' : 'Triggering next provider.',
          );
          providerResultPromises.push(resultPromise);
          pIndex += 1;
          break;
        case ProviderStatus.Error: {
          // Track the failed provider with its URL for better error reporting
          failedProviders.push({
            providerUrl: provider.getBaseUrl(),
            error: result.error,
          });

          // Extract detailed error context for logging
          const errorContext = extractEthersErrorContext(result.error);
          const errorMetadata = {
            ...providerMetadata,
            errorCode: errorContext.code,
            errorReason: errorContext.reason || (result.error as any)?.message,
            ...(errorContext.method && {
              contractMethod: errorContext.method,
            }),
            ...(errorContext.transaction?.to && {
              contractAddress: errorContext.transaction.to,
            }),
          };

          // If this is a blockchain error, stop trying additional providers as it's a permanent failure
          if (RPC_BLOCKCHAIN_ERRORS.includes((result.error as any)?.code)) {
            this.logger.debug(
              errorMetadata,
              `Blockchain error ${(result.error as any)?.code} for ${rpcCall} - stopping provider fallback (permanent failure)`,
            );
            break providerLoop;
          }

          this.logger.debug(
            errorMetadata,
            `Provider error for ${rpcCall}.`,
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
        failedProviders,
        `All providers failed for RPC call`,
        method,
        params,
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
        // For timeout, we don't have a specific provider URL - use the pending ones
        const pendingProviderUrls = providers
          .slice(pIndex - providerResultPromises.length, pIndex)
          .map((p) => p.getBaseUrl());
        const timeoutError = {
          providerUrl: pendingProviderUrls.join(', '),
          error: { status: ProviderStatus.Timeout },
        };
        const CombinedError = this.getCombinedProviderError(
          [timeoutError, ...failedProviders],
          `All providers timed out`,
          method,
          params,
        );
        throw new CombinedError();
      }
      case ProviderStatus.Error: {
        // Phase 2 error - we don't have the specific provider URL here
        // Add it as a generic error from pending providers
        const pendingError = {
          providerUrl: 'pending providers',
          error: result.error,
        };
        const CombinedError = this.getCombinedProviderError(
          [pendingError, ...failedProviders],
          `All providers failed for RPC call`,
          method,
          params,
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
    } catch (error: any) {
      // Extract detailed error context for debugging
      const rpcCall = formatRpcCall(method, params);
      const ethersContext = extractEthersErrorContext(error);
      const contextStr = formatEthersErrorContext(ethersContext);

      const errorDetails = {
        reqId,
        providerIndex: pIndex,
        rpcUrl: provider.getBaseUrl(),
        chain: this.network.name,
        chainId: this.network.chainId,
        rpcCall,
        errorCode: ethersContext.code,
        errorReason: ethersContext.reason || error?.message,
        ...(contextStr && { ethersContext: contextStr }),
      };

      if (this.options?.debug) {
        this.logger.error(errorDetails, `RPC call failed: ${rpcCall}`);
      }

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
    failedProviders: FailedProviderInfo[],
    fallbackMsg: string,
    method?: string,
    params?: any,
  ): new () => Error {
    this.logger.debug(fallbackMsg);

    // Format the RPC call for the error message if available
    const rpcCallInfo = method ? formatRpcCall(method, params || {}) : null;
    const chainInfo = `chain: ${this.getChainIdentifier()}`;

    // Extract just the errors for analysis
    const errors = failedProviders.map((fp) => fp.error);

    // Get the list of failed provider URLs for the error message
    const failedUrls = failedProviders
      .map((fp) => fp.providerUrl)
      .filter((url) => url && url !== 'pending providers');

    if (errors.length === 0) {
      const msg = rpcCallInfo
        ? `${fallbackMsg} | ${rpcCallInfo} | ${chainInfo}`
        : fallbackMsg;
      return class extends Error {
        constructor() {
          super(msg);
        }
      };
    }

    const rpcBlockchainError = errors.find((e: any) =>
      RPC_BLOCKCHAIN_ERRORS.includes(e?.code),
    );

    const rpcServerError = errors.find((e: any) =>
      RPC_SERVER_ERRORS.includes(e?.code),
    );

    const timedOutError = errors.find(
      (e: any) => e?.status === ProviderStatus.Timeout,
    );

    // Find which provider had the blockchain/server error
    const blockchainErrorProvider = failedProviders.find((fp: any) =>
      RPC_BLOCKCHAIN_ERRORS.includes(fp.error?.code),
    );
    const serverErrorProvider = failedProviders.find((fp: any) =>
      RPC_SERVER_ERRORS.includes(fp.error?.code),
    );

    if (rpcBlockchainError) {
      // All blockchain errors are non-retryable and take priority
      // Extract additional context from the ethers error
      const ethersContext = extractEthersErrorContext(rpcBlockchainError);
      const contextStr = formatEthersErrorContext(ethersContext);

      // Build a more descriptive error message
      const baseReason =
        (rpcBlockchainError as any).reason ??
        (rpcBlockchainError as any).code ??
        'Unknown error';
      const errorParts = [baseReason];

      if (rpcCallInfo) {
        errorParts.push(`RPC: ${rpcCallInfo}`);
      }
      errorParts.push(chainInfo);

      // Include the provider URL that returned the error
      if (blockchainErrorProvider?.providerUrl) {
        errorParts.push(`provider: ${blockchainErrorProvider.providerUrl}`);
      }

      // Include contract method if available from ethers error (e.g., "transferRemote(uint32,bytes32,uint256)")
      if (ethersContext.method) {
        errorParts.push(`contractMethod: ${ethersContext.method}`);
      }

      // Include target address if available
      if (ethersContext.transaction?.to) {
        errorParts.push(`contract: ${ethersContext.transaction.to}`);
      }

      // Include any additional error context that wasn't already captured
      if (contextStr && !errorParts.some((p) => p.includes(contextStr))) {
        errorParts.push(contextStr);
      }

      const enhancedMessage = errorParts.join(' | ');

      return class extends BlockchainError {
        constructor() {
          super(enhancedMessage, {
            cause: rpcBlockchainError as Error,
          });
        }
      };
    } else if (rpcServerError) {
      const baseMsg =
        (rpcServerError as any).error?.message ??
        getSmartProviderErrorMessage((rpcServerError as any).code);

      const errorParts = [baseMsg];
      if (rpcCallInfo) {
        errorParts.push(`RPC: ${rpcCallInfo}`);
      }
      errorParts.push(chainInfo);

      // Include the provider URL that returned the error
      if (serverErrorProvider?.providerUrl) {
        errorParts.push(`provider: ${serverErrorProvider.providerUrl}`);
      }

      // If multiple providers failed, list them
      if (failedUrls.length > 1) {
        errorParts.push(`failedProviders: [${failedUrls.join(', ')}]`);
      }

      const enhancedMessage = errorParts.join(' | ');

      return class extends Error {
        constructor() {
          super(enhancedMessage, { cause: rpcServerError });
        }
      };
    } else if (timedOutError) {
      const errorParts = [fallbackMsg];
      if (rpcCallInfo) {
        errorParts.push(`RPC: ${rpcCallInfo}`);
      }
      errorParts.push(chainInfo);

      // Include all the provider URLs that were tried
      if (failedUrls.length > 0) {
        errorParts.push(`triedProviders: [${failedUrls.join(', ')}]`);
      }

      const enhancedMessage = errorParts.join(' | ');

      return class extends Error {
        constructor() {
          super(enhancedMessage, {
            cause: timedOutError,
          });
        }
      };
    } else {
      this.logger.error(
        'Unhandled error case in combined provider error handler',
      );

      const errorParts = [fallbackMsg];
      if (rpcCallInfo) {
        errorParts.push(`RPC: ${rpcCallInfo}`);
      }
      errorParts.push(chainInfo);

      // Include all the provider URLs that were tried
      if (failedUrls.length > 0) {
        errorParts.push(`triedProviders: [${failedUrls.join(', ')}]`);
      }

      // Try to extract any useful info from the first error
      if (errors[0]) {
        const firstError = errors[0] as any;
        if (firstError.message) {
          errorParts.push(`error: ${firstError.message}`);
        }
      }

      const enhancedMessage = errorParts.join(' | ');

      return class extends Error {
        constructor() {
          super(enhancedMessage);
        }
      };
    }
  }
}

function chainMetadataToProviderNetwork(
  chainMetadata: ChainMetadata | ChainMetadataWithRpcConnectionInfo,
): providers.Network {
  return {
    name: chainMetadata.name,
    chainId: chainMetadata.chainId as number,
    // @ts-ignore add ensAddress to ChainMetadata
    ensAddress: chainMetadata.ensAddress,
  };
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
