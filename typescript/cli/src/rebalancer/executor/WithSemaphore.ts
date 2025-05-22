import { log } from '../../logger.js';
import { Config } from '../config/Config.js';
import type { IExecutor } from '../interfaces/IExecutor.js';
import type { RebalancingRoute } from '../interfaces/IStrategy.js';

/**
 * Prevents frequent rebalancing operations while bridges complete.
 */
export class WithSemaphore implements IExecutor {
  // Timestamp until which rebalancing should be blocked
  private waitUntil: number = 0;
  // Lock to prevent concurrent rebalance execution
  private executing: boolean = false;

  constructor(
    private readonly config: Config,
    private readonly executor: IExecutor,
  ) {}

  /**
   * Rebalance with timing control
   * @param routes - Routes to process
   */
  async rebalance(routes: RebalancingRoute[]) {
    if (this.executing) {
      log(`Currently executing rebalance. Skipping.`);

      return;
    }

    // No routes mean the system is balanced so we reset the timer to allow new rebalancing
    if (!routes.length) {
      log(
        `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
      );

      this.waitUntil = 0;
      return;
    }

    // Skip if still in waiting period
    if (Date.now() < this.waitUntil) {
      log(`Still in waiting period. Skipping rebalance.`);

      return;
    }

    // The wait period will be determined by the bridge with the highest wait tolerance
    const highestTolerance = this.getHighestLockTime(routes);

    try {
      // Execute rebalance
      this.executing = true;
      await this.executor.rebalance(routes);
    } finally {
      this.executing = false;
    }

    // Set new waiting period
    this.waitUntil = Date.now() + highestTolerance;

    log(
      `Rebalance semaphore locked for ${
        highestTolerance
      }ms. Releasing at timestamp ${new Date(this.waitUntil).toISOString()} (${this.waitUntil}).`,
    );
  }

  private getHighestLockTime(routes: RebalancingRoute[]) {
    return routes.reduce((highest, route) => {
      const origin = this.config.chains[route.fromChain];
      const bridgeLockTime = origin.bridgeLockTime;
      const overrideLockTime =
        origin.override?.[route.toChain].bridgeLockTime ?? 0;

      return Math.max(highest, bridgeLockTime, overrideLockTime);
    }, 0);
  }
}
