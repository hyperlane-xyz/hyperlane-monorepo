import type {
  ActionType,
  CreateRebalanceActionParams,
  CreateRebalanceIntentParams,
  IActionTracker,
  PartialInventoryIntent,
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from '@hyperlane-xyz/rebalancer';
import type { Domain } from '@hyperlane-xyz/utils';
import { rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'MockActionTracker' });

/**
 * Mock implementation of IActionTracker for simulation testing.
 *
 * This tracker maintains in-memory state without requiring a real
 * ExplorerClient or on-chain queries. The simulation engine updates
 * this tracker via callbacks when transfers/rebalances are initiated
 * or completed.
 */
export class MockActionTracker implements IActionTracker {
  private transfers = new Map<string, Transfer>();
  private intents = new Map<string, RebalanceIntent>();
  private actions = new Map<string, RebalanceAction>();
  private idCounter = 0;

  async initialize(): Promise<void> {
    logger.debug('MockActionTracker initialized');
  }

  // === Sync Operations (no-ops in simulation) ===

  async syncTransfers(): Promise<void> {
    // No-op: simulation manages state directly via callbacks
  }

  async syncRebalanceIntents(): Promise<void> {
    // No-op: simulation manages state directly
  }

  async syncRebalanceActions(): Promise<void> {
    // No-op: simulation manages state directly
  }

  async syncInventoryMovementActions(): Promise<{
    completed: number;
    failed: number;
  }> {
    // No-op: simulation doesn't use external bridges
    return { completed: 0, failed: 0 };
  }

  async getPartiallyFulfilledInventoryIntents(): Promise<
    PartialInventoryIntent[]
  > {
    // No inventory intents in simulation
    return [];
  }

  async getActionsByType(type: ActionType): Promise<RebalanceAction[]> {
    return Array.from(this.actions.values()).filter((a) => a.type === type);
  }

  async getActionsForIntent(intentId: string): Promise<RebalanceAction[]> {
    return Array.from(this.actions.values()).filter(
      (a) => a.intentId === intentId,
    );
  }

  async getInflightInventoryMovements(_origin: Domain): Promise<bigint> {
    // No inventory movements in simulation
    return 0n;
  }

  // === Transfer Management ===

  /**
   * Add a transfer (called by simulation when user transfer is initiated).
   */
  addTransfer(
    id: string,
    origin: Domain,
    destination: Domain,
    amount: bigint,
  ): void {
    const now = Date.now();
    this.transfers.set(id, {
      id,
      origin,
      destination,
      amount,
      status: 'in_progress',
      messageId: id, // Use transfer ID as message ID in simulation
      sender: '0x0000000000000000000000000000000000000000',
      recipient: '0x0000000000000000000000000000000000000000',
      createdAt: now,
      updatedAt: now,
    });
    logger.debug(
      { id, origin, destination, amount: amount.toString() },
      'Added transfer',
    );
  }

  /**
   * Remove a transfer (called by simulation when transfer delivers or fails).
   */
  removeTransfer(id: string): void {
    this.transfers.delete(id);
    logger.debug({ id }, 'Transfer removed');
  }

  async getTransfer(id: string): Promise<Transfer | undefined> {
    return this.transfers.get(id);
  }

  async getInProgressTransfers(): Promise<Transfer[]> {
    return Array.from(this.transfers.values()).filter(
      (t) => t.status === 'in_progress',
    );
  }

  async getTransfersByDestination(destination: Domain): Promise<Transfer[]> {
    return Array.from(this.transfers.values()).filter(
      (t) => t.destination === destination && t.status === 'in_progress',
    );
  }

  // === RebalanceIntent Management ===

  async createRebalanceIntent(
    params: CreateRebalanceIntentParams,
  ): Promise<RebalanceIntent> {
    const id = `intent-${++this.idCounter}`;
    const now = Date.now();
    const intent: RebalanceIntent = {
      id,
      origin: params.origin,
      destination: params.destination,
      amount: params.amount,
      bridge: params.bridge,
      priority: params.priority,
      strategyType: params.strategyType,
      status: 'not_started',
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(id, intent);
    logger.debug(
      {
        id,
        origin: params.origin,
        destination: params.destination,
        amount: params.amount.toString(),
      },
      'Created rebalance intent',
    );
    return intent;
  }

  async getRebalanceIntent(id: string): Promise<RebalanceIntent | undefined> {
    return this.intents.get(id);
  }

  async getActiveRebalanceIntents(): Promise<RebalanceIntent[]> {
    return Array.from(this.intents.values()).filter(
      (i) => i.status === 'not_started' || i.status === 'in_progress',
    );
  }

  async getRebalanceIntentsByDestination(
    destination: Domain,
  ): Promise<RebalanceIntent[]> {
    return Array.from(this.intents.values()).filter(
      (i) =>
        i.destination === destination &&
        (i.status === 'not_started' || i.status === 'in_progress'),
    );
  }

  async completeRebalanceIntent(id: string): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) {
      intent.status = 'complete';
      intent.updatedAt = Date.now();
      logger.debug({ id }, 'Rebalance intent completed');
    }
  }

  async cancelRebalanceIntent(id: string): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) {
      intent.status = 'cancelled';
      intent.updatedAt = Date.now();
      logger.debug({ id }, 'Rebalance intent cancelled');
    }
  }

  async failRebalanceIntent(id: string): Promise<void> {
    const intent = this.intents.get(id);
    if (intent) {
      intent.status = 'failed';
      intent.updatedAt = Date.now();
      logger.debug({ id }, 'Rebalance intent failed');
    }
  }

  // === RebalanceAction Management ===

  async createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction> {
    const id = `action-${++this.idCounter}`;
    const now = Date.now();
    const action: RebalanceAction = {
      id,
      type: params.type,
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
    this.actions.set(id, action);

    // Transition parent intent to in_progress
    const intent = this.intents.get(params.intentId);
    if (intent && intent.status === 'not_started') {
      intent.status = 'in_progress';
      intent.updatedAt = now;
    }

    logger.info(
      {
        id,
        intentId: params.intentId,
        messageId: params.messageId,
        origin: params.origin,
        destination: params.destination,
        amount: params.amount.toString(),
      },
      'Created rebalance action',
    );
    return action;
  }

  async getRebalanceAction(id: string): Promise<RebalanceAction | undefined> {
    return this.actions.get(id);
  }

  async getInProgressActions(): Promise<RebalanceAction[]> {
    return Array.from(this.actions.values()).filter(
      (a) => a.status === 'in_progress',
    );
  }

  async completeRebalanceAction(id: string): Promise<void> {
    const action = this.actions.get(id);
    if (action) {
      action.status = 'complete';
      action.updatedAt = Date.now();

      const intent = this.intents.get(action.intentId);
      if (intent) {
        intent.updatedAt = Date.now();
        const intentActions = Array.from(this.actions.values()).filter(
          (a) => a.intentId === intent.id,
        );
        const allComplete = intentActions.every((a) => a.status === 'complete');
        if (allComplete && intentActions.length > 0) {
          intent.status = 'complete';
        }
      }

      logger.debug({ id }, 'Rebalance action completed');
    }
  }

  async failRebalanceAction(id: string): Promise<void> {
    const action = this.actions.get(id);
    if (action) {
      action.status = 'failed';
      action.updatedAt = Date.now();
      logger.debug({ id }, 'Rebalance action failed');
    }
  }

  // === Debug ===

  async logStoreContents(): Promise<void> {
    logger.debug(
      {
        transfers: this.transfers.size,
        intents: this.intents.size,
        actions: this.actions.size,
      },
      'MockActionTracker store contents',
    );
  }

  /**
   * Clear all state (useful for test cleanup).
   */
  clear(): void {
    this.transfers.clear();
    this.intents.clear();
    this.actions.clear();
    this.idCounter = 0;
    logger.debug('MockActionTracker cleared');
  }

  // === Simulation-specific methods ===

  /**
   * Create an action for an intent by matching origin/destination/amount.
   * Used by simulation when bridge transfer is initiated, since RebalancerService
   * can't extract messageId from MockValueTransferBridge (no Dispatch event).
   * Returns the created action, or null if no matching intent found.
   */
  createActionForPendingIntent(
    origin: Domain,
    destination: Domain,
    amount: bigint,
    bridgeTransferId: string,
  ): RebalanceAction | null {
    // Find matching intent that needs an action (not_started or in_progress without enough fulfilled)
    const allIntents = Array.from(this.intents.values());
    const matchingIntents = allIntents
      .filter(
        (i) =>
          i.origin === origin &&
          i.destination === destination &&
          i.amount === amount &&
          (i.status === 'not_started' || i.status === 'in_progress'),
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (matchingIntents.length === 0) {
      logger.warn(
        { origin, destination, amount: amount.toString() },
        'No matching intent found for bridge transfer',
      );
      return null;
    }

    const intent = matchingIntents[0];
    const now = Date.now();
    const actionId = `action-${++this.idCounter}`;

    const action: RebalanceAction = {
      id: actionId,
      type: 'rebalance_message' as const,
      intentId: intent.id,
      origin,
      destination,
      amount,
      messageId: bridgeTransferId,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };

    this.actions.set(actionId, action);

    // Transition intent to in_progress if needed
    if (intent.status === 'not_started') {
      intent.status = 'in_progress';
      intent.updatedAt = now;
    }

    logger.debug(
      {
        actionId,
        intentId: intent.id,
        bridgeTransferId,
        origin,
        destination,
        amount: amount.toString(),
      },
      'Created action for pending intent (simulation bridge transfer)',
    );

    return action;
  }

  /**
   * Complete a rebalance action by matching origin/destination/amount.
   * Used by simulation when bridge delivers, since we don't have direct action ID correlation.
   * Finds the oldest in-progress action that matches and completes it.
   */
  completeRebalanceByRoute(
    origin: Domain,
    destination: Domain,
    amount: bigint,
  ): boolean {
    // Find matching in-progress action (oldest first)
    const allActions = Array.from(this.actions.values());
    const matchingActions = allActions
      .filter(
        (a) =>
          a.origin === origin &&
          a.destination === destination &&
          a.amount === amount &&
          a.status === 'in_progress',
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (matchingActions.length === 0) {
      logger.debug(
        { origin, destination, amount: amount.toString() },
        'No matching in-progress action found for delivery',
      );
      return false;
    }

    const action = matchingActions[0];
    action.status = 'complete';
    action.updatedAt = Date.now();

    const intent = this.intents.get(action.intentId);
    if (intent) {
      intent.updatedAt = Date.now();
      const intentActions = Array.from(this.actions.values()).filter(
        (a) => a.intentId === intent.id,
      );
      const allComplete = intentActions.every((a) => a.status === 'complete');
      if (allComplete && intentActions.length > 0) {
        intent.status = 'complete';
        logger.debug(
          { intentId: intent.id },
          'All actions complete, marking intent complete',
        );
      }
    }

    logger.debug(
      {
        actionId: action.id,
        intentId: action.intentId,
        origin,
        destination,
      },
      'Completed rebalance action by route',
    );
    return true;
  }

  /**
   * Fail a rebalance action by route match (origin, destination, amount).
   * Marks the action as failed and the parent intent as failed.
   */
  failRebalanceByRoute(
    origin: Domain,
    destination: Domain,
    amount: bigint,
  ): boolean {
    const allActions = Array.from(this.actions.values());
    const matchingActions = allActions
      .filter(
        (a) =>
          a.origin === origin &&
          a.destination === destination &&
          a.amount === amount &&
          a.status === 'in_progress',
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (matchingActions.length === 0) {
      return false;
    }

    const action = matchingActions[0];
    action.status = 'failed';
    action.updatedAt = Date.now();

    // Mark parent intent as failed
    const intent = this.intents.get(action.intentId);
    if (intent) {
      intent.status = 'failed';
      intent.updatedAt = Date.now();
    }

    logger.debug(
      {
        actionId: action.id,
        intentId: action.intentId,
        origin,
        destination,
      },
      'Failed rebalance action by route',
    );
    return true;
  }
}
