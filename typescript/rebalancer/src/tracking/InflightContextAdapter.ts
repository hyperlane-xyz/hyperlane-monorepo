import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type {
  InflightContext,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

import type { IActionTracker } from './IActionTracker.js';

/**
 * Adapter that converts ActionTracker data to InflightContext for strategies.
 *
 * This bridges the ActionTracker interface (which tracks individual entities
 * using domain IDs) with the InflightContext interface (which strategies
 * consume using chain names).
 */
export class InflightContextAdapter {
  constructor(
    private readonly actionTracker: IActionTracker,
    private readonly multiProvider: MultiProvider,
  ) {}

  /**
   * Get the current inflight context for strategy decision making.
   * Aggregates data from ActionTracker into the InflightContext format.
   */
  async getInflightContext(): Promise<InflightContext> {
    // Get in-progress user transfers
    const transfers = await this.actionTracker.getInProgressTransfers();

    // Get active rebalance intents (not_started + in_progress)
    const intents = await this.actionTracker.getActiveRebalanceIntents();

    // Convert transfers to RebalancingRoute format (domain IDs to chain names)
    const pendingTransfers: RebalancingRoute[] = transfers.map((t) => ({
      origin: this.multiProvider.getChainName(t.origin),
      destination: this.multiProvider.getChainName(t.destination),
      amount: t.amount,
    }));

    // Convert intents to RebalancingRoute format
    // Use remaining amount (amount - fulfilledAmount) as the pending amount
    const pendingRebalances: RebalancingRoute[] = intents
      .map((intent) => ({
        origin: this.multiProvider.getChainName(intent.origin),
        destination: this.multiProvider.getChainName(intent.destination),
        amount: intent.amount - intent.fulfilledAmount,
      }))
      .filter((route) => route.amount > 0n); // Only include routes with remaining amount

    return {
      pendingTransfers,
      pendingRebalances,
    };
  }
}
