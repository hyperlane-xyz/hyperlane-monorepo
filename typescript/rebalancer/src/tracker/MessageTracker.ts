import type { Logger } from 'pino';

import type {
  InflightContext,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

/**
 * Represents an inflight message (either a user transfer or a rebalance)
 */
export type InflightMessage = {
  id: string;
  origin: string;
  destination: string;
  amount: bigint;
  sender: string;
  recipient: string;
  isRebalance: boolean;
  timestamp: number;
};

export type MessageTrackerConfig = {
  /** Warp route ID for filtering messages */
  warpRouteId: string;
  /** Explorer GraphQL API URL */
  explorerUrl: string;
};

/**
 * MessageTracker tracks inflight Hyperlane messages for rebalancing decisions.
 *
 * Currently returns empty context - full implementation will be added in a follow-up PR.
 */
export class MessageTracker {
  private readonly logger: Logger;
  private readonly config: MessageTrackerConfig;

  constructor(config: MessageTrackerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'MessageTracker' });
  }

  /**
   * Get the current inflight context for strategy decision making
   */
  async getInflightContext(): Promise<InflightContext> {
    this.logger.debug(
      { warpRouteId: this.config.warpRouteId },
      'Fetching inflight context',
    );

    // TODO: Implement actual message fetching from Explorer API
    // For now, return empty context (no behavior change)
    const pendingTransfers: RebalancingRoute[] = [];
    const pendingRebalances: RebalancingRoute[] = [];

    this.logger.debug(
      {
        pendingTransfersCount: pendingTransfers.length,
        pendingRebalancesCount: pendingRebalances.length,
      },
      'Inflight context fetched',
    );

    return {
      pendingTransfers,
      pendingRebalances,
    };
  }

  /**
   * Record a rebalance that was just initiated by the rebalancer
   * This allows the tracker to include it in the inflight context before
   * it appears in the Explorer API
   */
  recordInitiatedRebalance(_route: RebalancingRoute, _messageId: string): void {
    // TODO: Implement caching of initiated rebalances
    this.logger.debug('recordInitiatedRebalance not yet implemented');
  }
}
