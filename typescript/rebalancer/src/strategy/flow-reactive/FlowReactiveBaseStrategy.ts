import type { Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';

import type { Metrics } from '../../metrics/Metrics.js';
import type {
  RawBalances,
  Route,
  StrategyRoute,
} from '../../interfaces/IStrategy.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { Transfer } from '../../tracking/types.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';

import { BaseStrategy, type Delta } from '../BaseStrategy.js';
import {
  FLOW_SCALE,
  type FlowReactiveParams,
  type FlowRecord,
  type FlowSignal,
} from './types.js';

export abstract class FlowReactiveBaseStrategy extends BaseStrategy {
  protected readonly actionTracker: IActionTracker;
  protected readonly params: FlowReactiveParams;
  protected readonly flowHistory: Map<ChainName, FlowRecord[]> = new Map();

  private readonly domainToChainName: Map<number, ChainName>;
  private cycleCount = 0;
  private lastTransfers: Transfer[] = [];
  private isRefreshingTransfers = false;

  constructor(
    chains: ChainName[],
    logger: Logger,
    bridgeConfigs: ChainMap<BridgeConfigWithOverride>,
    actionTracker: IActionTracker,
    params: FlowReactiveParams,
    metrics?: Metrics,
    tokensByChainName?: ChainMap<Token>,
    domainToChainName?: Map<number, ChainName>,
  ) {
    super(chains, logger, bridgeConfigs, metrics, tokensByChainName);
    this.actionTracker = actionTracker;
    this.params = params;
    this.domainToChainName = domainToChainName ?? new Map<number, ChainName>();

    for (const chain of chains) {
      this.flowHistory.set(chain, []);
    }
  }

  protected getCategorizedBalances(
    _balances: RawBalances,
    _pendingRebalances?: Route[],
    _proposedRebalances?: StrategyRoute[],
  ): { surpluses: Delta[]; deficits: Delta[] } {
    this.cycleCount++;
    this.updateFlowHistoryFromTransfers(this.lastTransfers);
    this.refreshTransfers();

    if (this.cycleCount <= this.params.coldStartCycles) {
      this.logger.debug(
        {
          cycleCount: this.cycleCount,
          coldStartCycles: this.params.coldStartCycles,
        },
        'Flow-reactive strategy in cold start, skipping',
      );
      return { surpluses: [], deficits: [] };
    }

    const signals = this.computeFlowSignals(this.flowHistory);
    const surpluses: Delta[] = [];
    const deficits: Delta[] = [];

    for (const signal of signals) {
      if (signal.magnitude === 0n) continue;
      if (signal.direction === 'surplus') {
        surpluses.push({ chain: signal.chain, amount: signal.magnitude });
      } else {
        deficits.push({ chain: signal.chain, amount: signal.magnitude });
      }
    }

    return { surpluses, deficits };
  }

  protected getNetFlow(records: FlowRecord[]): bigint {
    return records.reduce((sum, record) => sum + record.amount, 0n);
  }

  protected multiplyScaled(value: bigint, scale: bigint): bigint {
    return (value * scale) / FLOW_SCALE;
  }

  abstract computeFlowSignals(
    flowHistory: Map<ChainName, FlowRecord[]>,
  ): FlowSignal[];

  private updateFlowHistoryFromTransfers(transfers: Transfer[]): void {
    for (const chain of this.chains) {
      this.flowHistory.set(chain, []);
    }

    for (const transfer of transfers) {
      const originChain = this.domainToChain(transfer.origin);
      if (originChain) {
        const records = this.flowHistory.get(originChain) ?? [];
        records.push({
          chain: originChain,
          amount: transfer.amount,
          timestamp: transfer.createdAt,
        });
        this.flowHistory.set(originChain, records);
      }

      const destinationChain = this.domainToChain(transfer.destination);
      if (destinationChain) {
        const records = this.flowHistory.get(destinationChain) ?? [];
        records.push({
          chain: destinationChain,
          amount: -transfer.amount,
          timestamp: transfer.createdAt,
        });
        this.flowHistory.set(destinationChain, records);
      }
    }
  }

  private refreshTransfers(): void {
    if (this.isRefreshingTransfers) return;
    this.isRefreshingTransfers = true;

    this.actionTracker
      .getRecentTransfers(this.params.windowSizeMs)
      .then((transfers) => {
        this.lastTransfers = transfers;
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'Failed to refresh recent transfers');
      })
      .finally(() => {
        this.isRefreshingTransfers = false;
      });
  }

  private domainToChain(domain: number): ChainName | undefined {
    const chain = this.domainToChainName.get(domain);
    if (!chain) return undefined;
    return this.flowHistory.has(chain) ? chain : undefined;
  }
}
