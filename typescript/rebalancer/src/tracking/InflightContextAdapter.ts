import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type { InflightContext, Route } from '../interfaces/IStrategy.js';

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

    const pendingRebalances: Route[] = await Promise.all(
      intents.map(async (intent) => {
        let deliveredAmount = 0n;
        let awaitingDeliveryAmount = 0n;

        // For inventory intents, compute delivered and awaiting amounts from actions
        if (intent.executionMethod === 'inventory') {
          const actions = await this.actionTracker.getActionsForIntent(
            intent.id,
          );

          // Sum of complete inventory_deposit actions (message delivered)
          deliveredAmount = actions
            .filter(
              (a) => a.type === 'inventory_deposit' && a.status === 'complete',
            )
            .reduce((sum, a) => sum + a.amount, 0n);

          // Sum of in_progress inventory_deposit actions (tx confirmed, message pending)
          awaitingDeliveryAmount = actions
            .filter(
              (a) =>
                a.type === 'inventory_deposit' && a.status === 'in_progress',
            )
            .reduce((sum, a) => sum + a.amount, 0n);
        }

        return {
          origin: this.multiProvider.getChainName(intent.origin),
          destination: this.multiProvider.getChainName(intent.destination),
          amount: intent.amount,
          deliveredAmount,
          awaitingDeliveryAmount,
          executionMethod: intent.executionMethod,
          bridge: intent.bridge,
        };
      }),
    );

    const pendingTransfers = transfers.map((transfer) => ({
      origin: this.multiProvider.getChainName(transfer.origin),
      destination: this.multiProvider.getChainName(transfer.destination),
      amount: transfer.amount,
    }));

    return { pendingRebalances, pendingTransfers };
  }
}
