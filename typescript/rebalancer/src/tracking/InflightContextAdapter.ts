import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { InflightContext } from '../interfaces/IStrategy.js';

import type { IActionTracker } from './IActionTracker.js';

/**
 * Adapter that converts ActionTracker data to strategy-consumable InflightContext.
 * Handles conversion from Domain IDs (used by ActionTracker) to ChainNames (used by Strategy).
 */
export class InflightContextAdapter {
  constructor(
    private readonly actionTracker: IActionTracker,
    private readonly multiProvider: MultiProvider,
  ) {}

  /**
   * Get inflight context for strategy decision-making.
   * Only includes active rebalance intents.
   */
  async getInflightContext(): Promise<InflightContext> {
    const intents = await this.actionTracker.getActiveRebalanceIntents();

    const pendingRebalances = intents.map((intent) => ({
      origin: this.multiProvider.getChainName(intent.origin),
      destination: this.multiProvider.getChainName(intent.destination),
      // TODO: Review once inventory rebalancing is implemented and we expect
      // partially fulfilled intents. May need to use (amount - fulfilledAmount).
      amount: intent.amount,
    }));

    return { pendingRebalances };
  }
}
