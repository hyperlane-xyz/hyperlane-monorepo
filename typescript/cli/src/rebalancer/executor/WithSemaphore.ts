import { log } from '../../logger.js';
import { Config } from '../config/Config.js';
import { IExecutor } from '../interfaces/IExecutor.js';
import { RebalancingRoute } from '../interfaces/IStrategy.js';

/**
 * Prevents frequent rebalancing operations while bridges complete.
 */
export class WithSemaphore implements IExecutor {
  // Timestamp until which rebalancing should be blocked
  private waitUntil: number = 0;

  constructor(
    private readonly config: Config,
    private readonly executor: IExecutor,
  ) {}

  /**
   * Rebalance with timing control
   * @param routes - Routes to process
   */
  async rebalance(routes: RebalancingRoute[]) {
    // No routes means the system is balanced so we reset the timer to allow new rebalancing
    if (!routes.length) {
      // TODO: Update logging in this file, this is just to make current e2e tests pass
      log('No routes to execute');

      this.waitUntil = 0;
      return;
    }

    // Skip if still in waiting period
    if (Date.now() < this.waitUntil) {
      return;
    }

    // The wait period will be determined by the bridge with the highest wait tolerance
    const highestTolerance = this.getHighestTolerance(routes);

    // Execute rebalance
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
