import type {
  IInflightContextAdapter,
  InflightContext,
  Route,
} from '@hyperlane-xyz/rebalancer';
import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'MockInflightContextAdapter' });

/**
 * Mock implementation of IInflightContextAdapter for simulation testing.
 *
 * This adapter maintains lists of pending rebalances and user transfers,
 * allowing tests to control inflight context without needing a real
 * ActionTracker or ExplorerClient.
 *
 * Usage:
 * - Call addPendingRebalance() when a rebalance is initiated
 * - Call addPendingTransfer() when a user transfer is initiated
 * - Call removePendingRebalance() when a rebalance completes
 * - Call removePendingTransfer() when a user transfer completes
 * - The RebalancerService calls getInflightContext() during each poll cycle
 */
export class MockInflightContextAdapter implements IInflightContextAdapter {
  private pendingRebalances: Array<{ id: string; route: Route }> = [];
  private pendingTransfers: Array<{ id: string; route: Route }> = [];

  /**
   * Add a pending rebalance (called when bridge transfer is initiated)
   */
  addPendingRebalance(id: string, route: Route): void {
    this.pendingRebalances.push({ id, route });
    logger.debug(
      {
        id,
        origin: route.origin,
        destination: route.destination,
        amount: route.amount.toString(),
        totalPending: this.pendingRebalances.length,
      },
      'Added pending rebalance',
    );
  }

  /**
   * Add a pending user transfer (called when user initiates warp transfer)
   */
  addPendingTransfer(id: string, route: Route): void {
    this.pendingTransfers.push({ id, route });
    logger.debug(
      {
        id,
        origin: route.origin,
        destination: route.destination,
        amount: route.amount.toString(),
        totalPending: this.pendingTransfers.length,
      },
      'Added pending transfer',
    );
  }

  /**
   * Remove a pending rebalance (called when bridge transfer completes)
   */
  removePendingRebalance(id: string): boolean {
    const idx = this.pendingRebalances.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const removed = this.pendingRebalances.splice(idx, 1)[0];
      logger.debug(
        {
          id,
          origin: removed.route.origin,
          destination: removed.route.destination,
          amount: removed.route.amount.toString(),
          remainingPending: this.pendingRebalances.length,
        },
        'Removed pending rebalance',
      );
      return true;
    }
    logger.warn({ id }, 'Attempted to remove non-existent pending rebalance');
    return false;
  }

  /**
   * Remove a pending user transfer (called when warp transfer delivers)
   */
  removePendingTransfer(id: string): boolean {
    const idx = this.pendingTransfers.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const removed = this.pendingTransfers.splice(idx, 1)[0];
      logger.debug(
        {
          id,
          origin: removed.route.origin,
          destination: removed.route.destination,
          amount: removed.route.amount.toString(),
          remainingPending: this.pendingTransfers.length,
        },
        'Removed pending transfer',
      );
      return true;
    }
    logger.warn({ id }, 'Attempted to remove non-existent pending transfer');
    return false;
  }

  /**
   * Get current inflight context for strategy decision-making.
   * Called by RebalancerService during each poll cycle.
   */
  async getInflightContext(): Promise<InflightContext> {
    return {
      pendingRebalances: this.pendingRebalances.map((r) => r.route),
      pendingTransfers: this.pendingTransfers.map((r) => r.route),
    };
  }

  /**
   * Clear all pending items (useful for test cleanup)
   */
  clear(): void {
    this.pendingRebalances = [];
    this.pendingTransfers = [];
    logger.debug('Cleared all pending items');
  }

  /**
   * Get count of pending rebalances
   */
  getPendingRebalanceCount(): number {
    return this.pendingRebalances.length;
  }

  /**
   * Get count of pending transfers
   */
  getPendingTransferCount(): number {
    return this.pendingTransfers.length;
  }
}
