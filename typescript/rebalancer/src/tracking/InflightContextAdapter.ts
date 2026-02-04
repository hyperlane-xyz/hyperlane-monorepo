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
   * Includes active rebalance intents and in-progress user transfers.
   */
  async getInflightContext(): Promise<InflightContext> {
    const intents = await this.actionTracker.getActiveRebalanceIntents();
    const transfers = await this.actionTracker.getInProgressTransfers();

    const pendingRebalances = intents.map((intent) => ({
      origin: this.multiProvider.getChainName(intent.origin),
      destination: this.multiProvider.getChainName(intent.destination),
      // TODO: Review once inventory rebalancing is implemented and we expect
      // partially fulfilled intents. May need to use (amount - fulfilledAmount).
      amount: intent.amount,
      bridge: intent.bridge,
    }));

    const pendingTransfers = transfers.map((transfer) => ({
      origin: this.multiProvider.getChainName(transfer.origin),
      destination: this.multiProvider.getChainName(transfer.destination),
      amount: transfer.amount,
    }));

    return { pendingRebalances, pendingTransfers };
  }
}
