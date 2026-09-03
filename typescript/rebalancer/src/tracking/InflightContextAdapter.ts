import type { MultiProvider } from '@hyperlane-xyz/sdk';

import type {
  InflightContext,
  RouteWithContext,
} from '../interfaces/IStrategy.js';

import type { IActionTracker } from './IActionTracker.js';
import type { RebalanceAction } from './types.js';

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
    const inventoryIntentIds = intents
      .filter((intent) => intent.executionMethod === 'inventory')
      .map((intent) => intent.id);
    const actionsByIntent =
      inventoryIntentIds.length > 0
        ? await this.getActionsForIntents(inventoryIntentIds)
        : new Map<string, RebalanceAction[]>();

    const pendingRebalances: RouteWithContext[] = await Promise.all(
      intents.map(async (intent) => {
        let deliveredAmount = 0n;
        let awaitingDeliveryAmount = 0n;

        // For inventory intents, compute delivered and awaiting amounts from actions
        if (intent.executionMethod === 'inventory') {
          const actions = actionsByIntent.get(intent.id) ?? [];

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

  private async getActionsForIntents(
    intentIds: readonly string[],
  ): Promise<Map<string, RebalanceAction[]>> {
    return this.actionTracker.getActionsForIntents(intentIds);
  }
}
