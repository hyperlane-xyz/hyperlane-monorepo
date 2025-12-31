import type { Logger } from 'pino';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type {
  CreateRebalanceActionParams,
  CreateRebalanceIntentParams,
  IActionTracker,
} from './IActionTracker.js';
import type { RebalanceAction, RebalanceIntent, Transfer } from './types.js';

/**
 * Stub implementation of IActionTracker that returns empty data.
 *
 * This provides a no-op implementation that maintains current behavior
 * (no inflight tracking). The real implementation will be added in a follow-up PR.
 */
export class ActionTrackerStub implements IActionTracker {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'ActionTrackerStub' });
  }

  // === Lifecycle ===

  async initialize(): Promise<void> {
    this.logger.debug('ActionTrackerStub initialized (no-op)');
  }

  // === Sync Operations ===

  async syncTransfers(): Promise<void> {
    // No-op: real implementation will sync from Explorer
  }

  async syncRebalanceIntents(): Promise<void> {
    // No-op: real implementation will check fulfillment
  }

  async syncRebalanceActions(): Promise<void> {
    // No-op: real implementation will verify delivery
  }

  // === Transfer Queries ===

  async getInProgressTransfers(): Promise<Transfer[]> {
    return [];
  }

  async getTransfersByDestination(
    _destination: ChainName,
  ): Promise<Transfer[]> {
    return [];
  }

  // === RebalanceIntent Queries ===

  async getActiveRebalanceIntents(): Promise<RebalanceIntent[]> {
    return [];
  }

  async getRebalanceIntentsByDestination(
    _destination: ChainName,
  ): Promise<RebalanceIntent[]> {
    return [];
  }

  // === RebalanceIntent Management ===

  async createRebalanceIntent(
    params: CreateRebalanceIntentParams,
  ): Promise<RebalanceIntent> {
    const now = Date.now();
    const intent: RebalanceIntent = {
      id: `stub-intent-${now}`,
      origin: params.origin,
      destination: params.destination,
      amount: params.amount,
      status: 'not_started',
      fulfilledAmount: 0n,
      priority: params.priority,
      strategyType: params.strategyType,
      createdAt: now,
      updatedAt: now,
    };
    this.logger.debug({ intent }, 'Created stub rebalance intent');
    return intent;
  }

  async completeRebalanceIntent(_id: string): Promise<void> {
    this.logger.debug({ id: _id }, 'Completed stub rebalance intent (no-op)');
  }

  async cancelRebalanceIntent(_id: string): Promise<void> {
    this.logger.debug({ id: _id }, 'Cancelled stub rebalance intent (no-op)');
  }

  // === RebalanceAction Management ===

  async createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction> {
    const now = Date.now();
    const action: RebalanceAction = {
      id: `stub-action-${now}`,
      intentId: params.intentId,
      origin: params.origin,
      destination: params.destination,
      amount: params.amount,
      messageId: params.messageId,
      txHash: params.txHash,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };
    this.logger.debug({ action }, 'Created stub rebalance action');
    return action;
  }

  async completeRebalanceAction(_id: string): Promise<void> {
    this.logger.debug({ id: _id }, 'Completed stub rebalance action (no-op)');
  }

  async failRebalanceAction(_id: string): Promise<void> {
    this.logger.debug({ id: _id }, 'Failed stub rebalance action (no-op)');
  }
}
