import type { Logger } from 'pino';

import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import { getStrategyChainConfig } from '../config/types.js';
import type {
  IRebalancer,
  RebalanceExecutionResult,
  RebalanceRoute,
} from '../interfaces/IRebalancer.js';

/**
 * Prevents frequent rebalancing operations while bridges complete.
 */
export class WithSemaphore implements IRebalancer {
  // Timestamp until which rebalancing should be blocked
  private waitUntil: number = 0;
  // Lock to prevent concurrent rebalance execution
  private executing: boolean = false;
  private readonly logger: Logger;

  constructor(
    private readonly config: RebalancerConfig,
    private readonly rebalancer: IRebalancer,
    logger: Logger,
  ) {
    this.logger = logger.child({ class: WithSemaphore.name });
  }

  /**
   * Rebalance with timing control
   * @param routes - Routes to process
   */
  async rebalance(
    routes: RebalanceRoute[],
  ): Promise<RebalanceExecutionResult[]> {
    if (this.executing) {
      this.logger.info('Currently executing rebalance. Skipping.');

      return [];
    }

    // No routes mean the system is balanced so we reset the timer to allow new rebalancing
    if (!routes.length) {
      this.logger.info(
        'No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.',
      );

      this.waitUntil = 0;
      return [];
    }

    // Skip if still in waiting period
    if (Date.now() < this.waitUntil) {
      this.logger.info('Still in waiting period. Skipping rebalance.');

      return [];
    }

    // The wait period will be determined by the bridge with the highest wait tolerance
    const highestTolerance = this.getHighestLockTime(routes);

    let results: RebalanceExecutionResult[];
    try {
      // Execute rebalance
      this.executing = true;
      results = await this.rebalancer.rebalance(routes);
    } finally {
      this.executing = false;
    }

    // Set new waiting period
    this.waitUntil = Date.now() + highestTolerance;

    this.logger.info(
      {
        highestTolerance,
        waitUntil: this.waitUntil,
      },
      'Rebalance semaphore locked',
    );

    return results;
  }

  private getHighestLockTime(routes: RebalanceRoute[]) {
    return routes.reduce((highest, route) => {
      const origin = getStrategyChainConfig(
        this.config.strategyConfig,
        route.origin,
      );

      if (!origin) {
        this.logger.error({ route }, 'Chain not found in config. Skipping.');
        throw new Error(`Chain ${route.origin} not found in config`);
      }

      const bridgeLockTime = origin.bridgeLockTime ?? 0;
      const overrideLockTime =
        origin.override?.[route.destination]?.bridgeLockTime ?? 0;

      return Math.max(highest, bridgeLockTime, overrideLockTime);
    }, 0);
  }
}
