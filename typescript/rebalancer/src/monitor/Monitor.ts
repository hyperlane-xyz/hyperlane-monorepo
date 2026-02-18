import { type Logger } from 'pino';

import { HypERC20__factory, IMulticall3__factory } from '@hyperlane-xyz/core';
import {
  type EvmReadCall,
  type Token,
  TOKEN_STANDARD_TO_PROTOCOL,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, sleep } from '@hyperlane-xyz/utils';

import {
  type ConfirmedBlockTag,
  type ConfirmedBlockTags,
  type IMonitor,
  type MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from '../interfaces/IMonitor.js';
import { getConfirmedBlockTag } from '../utils/blockTag.js';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicall3Interface = IMulticall3__factory.createInterface();
const hypErc20Interface = HypERC20__factory.createInterface();

/**
 * Simple monitor implementation that polls warp route collateral balances and emits them as MonitorEvent.
 * Awaits the TokenInfo handler before starting the next cycle to prevent race conditions.
 */
export class Monitor implements IMonitor {
  private tokenInfoHandler?: (event: MonitorEvent) => void | Promise<void>;
  private errorHandler?: (event: Error) => void;
  private startHandler?: () => void;
  private isMonitorRunning = false;
  private resolveStop: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  /**
   * @param checkFrequency - The frequency to poll balances in ms.
   */
  constructor(
    private readonly checkFrequency: number,
    private readonly warpCore: WarpCore,
    private readonly logger: Logger,
  ) {}

  private async computeConfirmedBlockTags(): Promise<ConfirmedBlockTags> {
    const blockTags: ConfirmedBlockTags = {};
    const chains = new Set(this.warpCore.tokens.map((t) => t.chainName));

    for (const chain of chains) {
      blockTags[chain] = await getConfirmedBlockTag(
        this.warpCore.multiProvider,
        chain,
        this.logger,
      );
    }

    return blockTags;
  }

  // overloads from IMonitor
  on(
    eventName: MonitorEventType.TokenInfo,
    fn: (event: MonitorEvent) => void | Promise<void>,
  ): this;
  on(eventName: MonitorEventType.Error, fn: (event: Error) => void): this;
  on(eventName: MonitorEventType.Start, fn: () => void): this;
  on(eventName: string, fn: (...args: any[]) => void | Promise<void>): this {
    switch (eventName) {
      case MonitorEventType.TokenInfo:
        this.tokenInfoHandler = fn as (
          event: MonitorEvent,
        ) => void | Promise<void>;
        break;
      case MonitorEventType.Error:
        this.errorHandler = fn as (event: Error) => void;
        break;
      case MonitorEventType.Start:
        this.startHandler = fn as () => void;
        break;
    }
    return this;
  }

  async start() {
    if (this.isMonitorRunning) {
      // Cannot start the same monitor multiple times
      this.errorHandler?.(new MonitorStartError('Monitor already running'));
      return;
    }

    try {
      this.isMonitorRunning = true;
      this.logger.debug(
        { checkFrequency: this.checkFrequency },
        'Monitor started',
      );
      this.startHandler?.();

      while (this.isMonitorRunning) {
        const cycleStart = Date.now();

        try {
          this.logger.debug('Polling cycle started');

          const confirmedBlockTags = await this.computeConfirmedBlockTags();

          const event: MonitorEvent = {
            tokensInfo: [],
            confirmedBlockTags,
          };

          const supplies = await this.getBridgedSuppliesBatch(
            this.warpCore.tokens,
            confirmedBlockTags,
          );

          for (let i = 0; i < this.warpCore.tokens.length; i++) {
            event.tokensInfo.push({
              token: this.warpCore.tokens[i],
              bridgedSupply: supplies[i],
            });
          }

          if (this.tokenInfoHandler) {
            await this.tokenInfoHandler(event);
          }
          this.logger.debug('Polling cycle completed');
        } catch (error) {
          this.errorHandler?.(
            new MonitorPollingError(
              `Error during monitor execution cycle: ${(error as Error).message}`,
              error as Error,
            ),
          );
        }

        // Smart sleep: only wait for remaining time after cycle completes
        const elapsed = Date.now() - cycleStart;
        const remaining = this.checkFrequency - elapsed;
        if (remaining > 0) {
          await sleep(remaining);
        }
        // If elapsed >= checkFrequency, start next cycle immediately
      }
    } catch (error) {
      this.errorHandler?.(
        new MonitorStartError(
          `Error starting monitor: ${(error as Error).message}`,
          error as Error,
        ),
      );
    }

    // After the loop has been gracefully terminated, we can clean up.
    this.tokenInfoHandler = undefined;
    this.errorHandler = undefined;
    this.startHandler = undefined;
    this.logger.info('Monitor stopped');

    // If stop() was called, resolve the promise to signal that we're done.
    if (this.resolveStop) {
      this.resolveStop();
      this.resolveStop = null;
      this.stopPromise = null;
    }
  }

  private async getBridgedSuppliesBatch(
    tokens: Token[],
    confirmedBlockTags: ConfirmedBlockTags,
  ): Promise<(bigint | undefined)[]> {
    const results: (bigint | undefined)[] = Array.from({
      length: tokens.length,
    });

    // Group tokens by chain, tracking original indices
    const chainGroups = new Map<string, { token: Token; index: number }[]>();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const chain = token.chainName;
      if (!chainGroups.has(chain)) chainGroups.set(chain, []);
      chainGroups.get(chain)!.push({ token, index: i });
    }

    for (const [chain, group] of chainGroups) {
      const blockTag = confirmedBlockTags[chain];

      // Separate batchable EVM tokens from those needing individual calls
      const batchable: { token: Token; index: number; call: EvmReadCall }[] =
        [];
      const individual: { token: Token; index: number }[] = [];

      for (const entry of group) {
        const { token } = entry;
        if (!token.isHypToken()) {
          this.logger.warn(
            {
              chain: token.chainName,
              tokenSymbol: token.symbol,
              tokenAddress: token.addressOrDenom,
            },
            'Cannot get bridged balance for a non-Hyperlane token',
          );
          results[entry.index] = undefined;
          continue;
        }

        const protocol = TOKEN_STANDARD_TO_PROTOCOL[token.standard];
        if (protocol !== ProtocolType.Ethereum) {
          individual.push(entry);
          continue;
        }

        const call = this.buildBridgedSupplyCall(token);
        if (call) {
          batchable.push({ ...entry, call });
        } else {
          individual.push(entry);
        }
      }

      // Batch EVM calls via multicall
      if (batchable.length > 0) {
        const multiProvider = this.warpCore.multiProvider.toMultiProvider();
        const calls = batchable.map((b) => ({
          ...b.call,
          allowFailure: true,
        }));

        try {
          const batchResults = await multiProvider.multicall(chain, calls, {
            blockTag,
          });
          for (let i = 0; i < batchable.length; i++) {
            const raw = batchResults[i];
            if (raw != null) {
              results[batchable[i].index] = BigInt(raw.toString());
              this.logger.debug(
                { chain, blockTag },
                'Queried confirmed balance',
              );
            } else {
              // Multicall sub-call failed; fall back individually
              individual.push(batchable[i]);
            }
          }
        } catch {
          // Entire multicall failed (e.g. historical block not available);
          // retry all batchable tokens without blockTag
          this.logger.warn(
            { chain, blockTag },
            'Batch historical query failed, retrying batch with latest block',
          );
          try {
            const retryResults = await multiProvider.multicall(chain, calls);
            for (let i = 0; i < batchable.length; i++) {
              const raw = retryResults[i];
              if (raw != null) {
                results[batchable[i].index] = BigInt(raw.toString());
              } else {
                results[batchable[i].index] = undefined;
                this.logger.warn(
                  {
                    chain,
                    tokenSymbol: batchable[i].token.symbol,
                    tokenAddress: batchable[i].token.addressOrDenom,
                  },
                  'Bridged supply not found for token',
                );
              }
            }
          } catch {
            // Even latest-block batch failed; fall back individually
            for (const entry of batchable) {
              individual.push(entry);
            }
          }
        }
      }

      // Individual fallback for non-batchable or failed tokens
      await Promise.all(
        individual.map(async (entry) => {
          results[entry.index] = await this.getTokenBridgedSupply(
            entry.token,
            blockTag,
          );
        }),
      );
    }

    return results;
  }

  private buildBridgedSupplyCall(token: Token): EvmReadCall | null {
    const { standard, addressOrDenom } = token;

    switch (standard) {
      // Synthetic tokens: totalSupply() on the HypERC20 contract
      case TokenStandard.EvmHypSynthetic:
      case TokenStandard.EvmHypSyntheticRebase:
        return {
          contract: {
            address: addressOrDenom,
            interface: hypErc20Interface,
          },
          functionName: 'totalSupply',
          args: [],
        };

      // Native tokens: getEthBalance(tokenAddress) self-call on multicall3
      case TokenStandard.EvmHypNative:
        return {
          contract: {
            address: MULTICALL3_ADDRESS,
            interface: multicall3Interface,
          },
          functionName: 'getEthBalance',
          args: [addressOrDenom],
        };

      // Complex standards requiring multi-step resolution; not batchable
      default:
        return null;
    }
  }

  private async getTokenBridgedSupply(
    token: Token,
    blockTag?: ConfirmedBlockTag,
  ): Promise<bigint | undefined> {
    if (!token.isHypToken()) {
      this.logger.warn(
        {
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Cannot get bridged balance for a non-Hyperlane token',
      );
      return;
    }

    const adapter = token.getHypAdapter(this.warpCore.multiProvider);
    let bridgedSupply: bigint | undefined;

    try {
      bridgedSupply = await adapter.getBridgedSupply({ blockTag });
      this.logger.debug(
        { chain: token.chainName, blockTag },
        'Queried confirmed balance',
      );
    } catch (error) {
      this.logger.warn(
        {
          chain: token.chainName,
          blockTag,
          error: (error as Error).message,
        },
        'Historical block query failed, falling back to latest',
      );
      bridgedSupply = await adapter.getBridgedSupply();
    }

    if (bridgedSupply === undefined) {
      this.logger.warn(
        {
          chain: token.chainName,
          tokenSymbol: token.symbol,
          tokenAddress: token.addressOrDenom,
        },
        'Bridged supply not found for token',
      );
    }

    return bridgedSupply;
  }

  stop(): Promise<void> {
    if (!this.isMonitorRunning) return Promise.resolve();

    // If stop is already in progress, return the existing promise
    if (this.stopPromise) return this.stopPromise;

    this.logger.info('Stopping monitor...');
    // Signal the while loop to terminate after its current iteration
    this.isMonitorRunning = false;

    // Create a promise that will be resolved by the start() method
    // once the loop and cleanup are complete.
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    return this.stopPromise;
  }
}
