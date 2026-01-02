import type { Domain } from '@hyperlane-xyz/utils';

import type { RebalanceAction, RebalanceIntent, Transfer } from './types.js';

export interface CreateRebalanceIntentParams {
  origin: Domain;
  destination: Domain;
  amount: bigint;
  priority?: number;
  strategyType?: string;
}

export interface CreateRebalanceActionParams {
  intentId: string;
  origin: Domain;
  destination: Domain;
  amount: bigint;
  messageId: string;
  txHash?: string;
}

/**
 * ActionTracker manages the lifecycle of tracked entities:
 * - Transfers: Inflight user warp transfers
 * - RebalanceIntents: Intents to move collateral
 * - RebalanceActions: On-chain actions to fulfill intents
 */
export interface IActionTracker {
  // === Lifecycle ===

  /**
   * Initialize the tracker by loading state from Explorer and on-chain data.
   * Called once on startup.
   */
  initialize(): Promise<void>;

  // === Sync Operations ===

  /**
   * Sync inflight user transfers from Explorer and verify delivery status.
   */
  syncTransfers(): Promise<void>;

  /**
   * Sync rebalance intents by checking fulfillment status.
   */
  syncRebalanceIntents(): Promise<void>;

  /**
   * Sync rebalance actions by verifying on-chain message delivery.
   */
  syncRebalanceActions(): Promise<void>;

  // === Transfer Queries ===

  /**
   * Get all transfers currently in progress.
   */
  getInProgressTransfers(): Promise<Transfer[]>;

  /**
   * Get all transfers destined for a specific domain.
   */
  getTransfersByDestination(destination: Domain): Promise<Transfer[]>;

  // === RebalanceIntent Queries ===

  /**
   * Get all active rebalance intents (not_started + in_progress).
   */
  getActiveRebalanceIntents(): Promise<RebalanceIntent[]>;

  /**
   * Get all rebalance intents destined for a specific domain.
   */
  getRebalanceIntentsByDestination(
    destination: Domain,
  ): Promise<RebalanceIntent[]>;

  // === RebalanceIntent Management ===

  /**
   * Create a new rebalance intent.
   * Initial status: 'not_started'
   */
  createRebalanceIntent(
    params: CreateRebalanceIntentParams,
  ): Promise<RebalanceIntent>;

  /**
   * Mark a rebalance intent as complete.
   */
  completeRebalanceIntent(id: string): Promise<void>;

  /**
   * Cancel a rebalance intent.
   */
  cancelRebalanceIntent(id: string): Promise<void>;

  // === RebalanceAction Management ===

  /**
   * Create a new rebalance action.
   * Initial status: 'in_progress'
   * Also transitions parent intent from 'not_started' to 'in_progress'.
   */
  createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction>;

  /**
   * Mark a rebalance action as complete.
   * Updates parent intent's fulfilledAmount.
   */
  completeRebalanceAction(id: string): Promise<void>;

  /**
   * Mark a rebalance action as failed.
   */
  failRebalanceAction(id: string): Promise<void>;
}
