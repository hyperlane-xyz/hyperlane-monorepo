import { providers } from 'ethers';
import { Logger } from 'pino';

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
  ChainMetadataWithRpcConnectionInfo,
  ProviderPerformResult,
  ProviderStatus,
  ProviderTimeoutResult,
  SmartProviderOptions,
} from './types.js';

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BASE_RETRY_DELAY_MS = 250; // 0.25 seconds
const DEFAULT_STAGGER_DELAY_MS = 1000; // 1 seconds

type HyperlaneProvider = HyperlaneEtherscanProvider | HyperlaneJsonRpcProvider;

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
   * This perform method will trigger any providers that support the method
   * one at a time in preferential order. If one is slow to respond, the next is triggered.
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
    while (true) {
      // Trigger the next provider in line
      if (pIndex < providers.length) {
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

        if (result.status === ProviderStatus.Success) {
          return result.value;
        } else if (result.status === ProviderStatus.Timeout) {
          this.logger.debug(
            `Slow response from provider #${pIndex}.${
              !isLastProvider ? ' Triggering next provider.' : ''
            }`,
          );
          providerResultPromises.push(resultPromise);
          pIndex += 1;
        } else if (result.status === ProviderStatus.Error) {
          this.logger.warn(
            `Error from provider #${pIndex}: ${result.error} - ${
              !isLastProvider ? ' Triggering next provider.' : ''
            }`,
          );
          providerResultErrors.push(result.error);
          pIndex += 1;
        } else {
          throw new Error('Unexpected result from provider');
        }

        // All providers already triggered, wait for one to complete or all to fail/timeout
      } else if (providerResultPromises.length > 0) {
        const timeoutPromise = timeoutResult(
          this.options?.fallbackStaggerMs || DEFAULT_STAGGER_DELAY_MS,
          20,
        );
        const resultPromise = this.waitForProviderSuccess(
          providerResultPromises,
        );
        const result = await Promise.race([resultPromise, timeoutPromise]);

        if (result.status === ProviderStatus.Success) {
          return result.value;
        } else if (result.status === ProviderStatus.Timeout) {
          this.throwCombinedProviderErrors(
            providerResultErrors,
            `All providers timed out for method ${method}`,
          );
        } else if (result.status === ProviderStatus.Error) {
          this.throwCombinedProviderErrors(
            [result.error, ...providerResultErrors],
            `All providers failed for method ${method} and params ${JSON.stringify(
              params,
              null,
              2,
            )}`,
          );
        } else {
          throw new Error('Unexpected result from provider');
        }

        // All providers have already failed, all hope is lost
      } else {
        this.throwCombinedProviderErrors(
          providerResultErrors,
          `All providers failed for method ${method} and params ${JSON.stringify(
            params,
            null,
            2,
          )}`,
        );
      }
    }
  }

  // Warp for additional logging and error handling
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

  protected throwCombinedProviderErrors(
    errors: unknown[],
    fallbackMsg: string,
  ): void {
    this.logger.error(fallbackMsg);
    // TODO inspect the errors in some clever way to choose which to throw
    if (errors.length > 0) throw errors[0];
    else throw new Error(fallbackMsg);
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
