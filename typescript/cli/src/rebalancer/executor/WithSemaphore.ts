import { Config } from '../config/Config.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

/**
 * Timing-based guard for the rebalancer that prevents frequent operations
 * and waits for bridge transactions to complete before new rebalancing.
 */
export class WithSemaphore implements IExecutor {
  // Timestamp until which rebalancing should be blocked
  private waitUntil: number = 0;

  constructor(
    private readonly config: Config,
    private readonly executor: IExecutor,
  ) {}

  /**
   * Executes rebalancing only if outside waiting period or if no rebalancing is needed
   * @param routes - Rebalancing routes to process
   */
  async rebalance(routes: RebalancingRoute[]) {
    // Skip if still in waiting period and rebalancing is needed
    if (Date.now() < this.waitUntil && routes.length) {
      return;
    }

    const highestTolerance = this.getHighestTolerance(routes);

    await this.executor.rebalance(routes);

    // Set new waiting period
    this.waitUntil = Date.now() + highestTolerance;
  }

  private getHighestTolerance(routes: RebalancingRoute[]) {
    return routes.reduce((highest, route) => {
      const bridgeTolerance =
        this.config.chains[route.fromChain]?.bridgeTolerance;

      if (!bridgeTolerance) {
        throw new Error(
          `Bridge tolerance not found for chain ${route.fromChain}`,
        );
      }

      return Math.max(highest, bridgeTolerance);
    }, 0);
  }
}
