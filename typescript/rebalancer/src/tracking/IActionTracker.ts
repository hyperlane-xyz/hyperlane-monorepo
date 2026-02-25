import type { Address, Domain } from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../config/types.js';
import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import type { ConfirmedBlockTags } from '../interfaces/IMonitor.js';

import type {
  ActionType,
  ExecutionMethod,
  PartialInventoryIntent,
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from './types.js';

export interface CreateRebalanceIntentParams {
  origin: Domain;
  destination: Domain;
  amount: bigint;
  bridge?: Address;
  priority?: number;
  strategyType?: string;
  executionMethod?: ExecutionMethod;
  externalBridge?: ExternalBridgeType;
}

export interface CreateRebalanceActionParams {
  intentId: string;
  origin: Domain;
  destination: Domain;
  amount: bigint;
  type: ActionType; // Required - type of action being created
  messageId?: string; // Optional - not needed for inventory_movement
  txHash?: string;
  externalBridgeTransferId?: string; // Optional - for inventory_movement (external transfer bridge ID)
  externalBridgeId?: ExternalBridgeType; // Optional - for inventory_movement (e.g., 'lifi')
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
   * @param confirmedBlockTags Optional block tags from Monitor for consistent state queries
   */
  syncTransfers(confirmedBlockTags?: ConfirmedBlockTags): Promise<void>;

  /**
   * Sync rebalance intents by checking fulfillment status.
   */
  syncRebalanceIntents(): Promise<void>;

  /**
   * Sync rebalance actions by verifying on-chain message delivery.
   * @param confirmedBlockTags Optional block tags from Monitor for consistent state queries
   */
  syncRebalanceActions(confirmedBlockTags?: ConfirmedBlockTags): Promise<void>;

  /**
   * Sync inventory_movement actions by checking their status via external bridge API.
   * This is separate from syncRebalanceActions because inventory_movement actions
   * don't use Hyperlane messages and need to query the bridge's status API.
   *
   * @param externalBridgeRegistry - Bridge registry to query for status
   * @returns Count of completed and failed actions
   */
  syncInventoryMovementActions(
    externalBridgeRegistry: Partial<ExternalBridgeRegistry>,
  ): Promise<{ completed: number; failed: number }>;

  // === Transfer Queries ===

  /**
   * Get a single transfer by ID.
   */
  getTransfer(id: string): Promise<Transfer | undefined>;

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
   * Get a single rebalance intent by ID.
   */
  getRebalanceIntent(id: string): Promise<RebalanceIntent | undefined>;

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

  /**
   * Returns inventory intents that have remaining work.
   * Intents with in-flight deposits are included but marked via hasInflightDeposit —
   * callers must check before continuing.
   * Returns enriched data with computed values derived from action states.
   */
  getPartiallyFulfilledInventoryIntents(): Promise<PartialInventoryIntent[]>;

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
   * Used for deliberate stops (e.g., stale fulfillment).
   */
  cancelRebalanceIntent(id: string): Promise<void>;

  /**
   * Mark a rebalance intent as failed.
   * Used when tx execution was attempted but failed.
   */
  failRebalanceIntent(id: string): Promise<void>;

  // === RebalanceAction Queries ===

  /**
   * Get actions filtered by type.
   * @param type - Action type to filter by
   */
  getActionsByType(type: ActionType): Promise<RebalanceAction[]>;

  /**
   * Get all actions associated with a specific intent.
   * @param intentId - ID of the intent
   */
  getActionsForIntent(intentId: string): Promise<RebalanceAction[]>;

  /**
   * Get total inflight inventory movement amount from a specific chain.
   * Returns the sum of amounts for all in_progress inventory_movement actions
   * that originate from the specified domain.
   *
   * @param origin - Domain ID of the origin chain
   * @returns Total amount being moved out via inventory movements
   */
  getInflightInventoryMovements(origin: Domain): Promise<bigint>;

  /**
   * Get a single rebalance action by ID.
   */
  getRebalanceAction(id: string): Promise<RebalanceAction | undefined>;

  /**
   * Get all rebalance actions currently in progress.
   */
  getInProgressActions(): Promise<RebalanceAction[]>;

  // === RebalanceAction Management ===

  createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction>;

  /**
   * Mark a rebalance action as complete.
   * Checks if parent intent is now fully fulfilled and marks it complete if so.
   */
  completeRebalanceAction(id: string): Promise<void>;

  /**
   * Mark a rebalance action as failed.
   */
  failRebalanceAction(id: string): Promise<void>;

  // === Debug ===

  /**
   * Log the contents of all stores for debugging purposes.
   */
  logStoreContents(): Promise<void>;
}
