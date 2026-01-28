import type { Logger } from 'pino';

import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';
import { type ExplorerClient } from '../utils/ExplorerClient.js';

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
    private readonly routersByDomain: Record<number, string>,
    logger: Logger,
  ) {
    this.logger = logger.child({ class: WithInflightGuard.name });
  }

  async rebalance(routes: RebalancingRoute[]): Promise<void> {
    // Always enforce the inflight guard
    if (routes.length === 0) {
      return this.rebalancer.rebalance(routes);
    }

    const chains = Object.keys(this.config.strategyConfig.chains);
    const bridges = chains.map(
      (chain) => this.config.strategyConfig.chains[chain].bridge,
    );

    let hasInflightRebalances = false;
    try {
      hasInflightRebalances = await this.explorer.hasUndeliveredRebalance(
        {
          bridges,
          routersByDomain: this.routersByDomain,
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
}
