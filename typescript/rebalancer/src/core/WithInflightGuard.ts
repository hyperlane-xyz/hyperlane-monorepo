import type { Logger } from 'pino';

import {
  ChainMetadataManager,
  RebalancerStrategyOptions,
  type SingleStrategyConfig,
} from '@hyperlane-xyz/sdk';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { ExplorerClient } from '../utils/ExplorerClient.js';

/**
 * Prevents rebalancing if there are inflight rebalances for the warp route.
 */
export class WithInflightGuard implements IRebalancer {
  private readonly logger: Logger;

  constructor(
    private readonly config: RebalancerConfig,
    private readonly rebalancer: IRebalancer,
    private readonly explorer: ExplorerClient,
    private readonly txSender: string,
    private readonly chainManager: ChainMetadataManager,
    logger: Logger,
  ) {
    this.logger = logger.child({ class: WithInflightGuard.name });
  }

  async rebalance(routes: RebalancingRoute[]): Promise<void> {
    // Always enforce the inflight guard
    if (routes.length === 0) {
      return this.rebalancer.rebalance(routes);
    }

    const { chains, bridges } = this.getChainsAndBridges();
    const domains = chains.map((chain) => this.chainManager.getDomainId(chain));

    let hasInflightRebalances = false;
    try {
      hasInflightRebalances = await this.explorer.hasUndeliveredRebalance(
        {
          bridges,
          domains: Array.from(new Set(domains)),
          txSender: this.txSender,
          limit: 5,
        },
        this.logger,
      );
    } catch (e: any) {
      this.logger.error(
        { status: e.status, body: e.body },
        'Explorer inflight query failed',
      );
      throw e;
    }

    if (hasInflightRebalances) {
      this.logger.info(
        'Inflight rebalance detected via Explorer; skipping this cycle',
      );
      return;
    }

    return this.rebalancer.rebalance(routes);
  }

  /**
   * Get chains and bridges from strategy config, handling composite strategies
   */
  private getChainsAndBridges(): { chains: string[]; bridges: string[] } {
    const strategyConfig = this.config.strategyConfig;

    if (
      strategyConfig.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      const chains = new Set<string>();
      const bridges = new Set<string>();

      for (const subStrategy of (strategyConfig as any)
        .strategies as SingleStrategyConfig[]) {
        for (const [chain, config] of Object.entries(subStrategy.chains)) {
          chains.add(chain);
          bridges.add(config.bridge);
        }
      }

      return { chains: Array.from(chains), bridges: Array.from(bridges) };
    }

    const chains = Object.keys(strategyConfig.chains);
    const bridgesArr = chains.map(
      (chain) => strategyConfig.chains[chain].bridge,
    );
    return { chains, bridges: bridgesArr };
  }
}
