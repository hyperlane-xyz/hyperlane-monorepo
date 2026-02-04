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
  private pendingRebalances: Route[] = [];
  private pendingTransfers: Route[] = [];

  /**
   * Add a pending rebalance (called when bridge transfer is initiated)
   */
  addPendingRebalance(route: Route): void {
    this.pendingRebalances.push(route);
    logger.debug(
      {
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
  addPendingTransfer(route: Route): void {
    this.pendingTransfers.push(route);
    logger.debug(
      {
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
  removePendingRebalance(origin: string, destination: string): boolean {
    const idx = this.pendingRebalances.findIndex(
      (r) => r.origin === origin && r.destination === destination,
    );
    if (idx >= 0) {
      const removed = this.pendingRebalances.splice(idx, 1)[0];
      logger.debug(
        {
          origin,
          destination,
          amount: removed.amount.toString(),
          remainingPending: this.pendingRebalances.length,
        },
        'Removed pending rebalance',
      );
      return true;
    }
    logger.warn(
      { origin, destination },
      'Attempted to remove non-existent pending rebalance',
    );
    return false;
  }

  /**
   * Remove a pending user transfer (called when warp transfer delivers)
   */
  removePendingTransfer(origin: string, destination: string): boolean {
    const idx = this.pendingTransfers.findIndex(
      (r) => r.origin === origin && r.destination === destination,
    );
    if (idx >= 0) {
      const removed = this.pendingTransfers.splice(idx, 1)[0];
      logger.debug(
        {
          origin,
          destination,
          amount: removed.amount.toString(),
          remainingPending: this.pendingTransfers.length,
        },
        'Removed pending transfer',
      );
      return true;
    }
    logger.warn(
      { origin, destination },
      'Attempted to remove non-existent pending transfer',
    );
    return false;
  }

  /**
   * Get current inflight context for strategy decision-making.
   * Called by RebalancerService during each poll cycle.
   */
  async getInflightContext(): Promise<InflightContext> {
    return {
      pendingRebalances: [...this.pendingRebalances],
      pendingTransfers: [...this.pendingTransfers],
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
