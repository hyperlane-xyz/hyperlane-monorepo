import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type { HyperlaneCore } from '@hyperlane-xyz/sdk';
import type { Address, Domain } from '@hyperlane-xyz/utils';
import { parseWarpRouteMessage } from '@hyperlane-xyz/utils';

import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type {
  ConfirmedBlockTag,
  ConfirmedBlockTags,
} from '../interfaces/IMonitor.js';
import type {
  ExplorerClient,
  ExplorerMessage,
} from '../utils/ExplorerClient.js';

import type {
  CreateRebalanceActionParams,
  CreateRebalanceIntentParams,
  IActionTracker,
} from './IActionTracker.js';
import type {
  ActionType,
  IRebalanceActionStore,
  IRebalanceIntentStore,
  ITransferStore,
  PartialInventoryIntent,
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from './types.js';

export interface ActionTrackerConfig {
  routersByDomain: Record<number, string>; // Domain ID → router address (source of truth for routers and domains)
  bridges: Address[]; // Bridge contract addresses for rebalance action queries
  rebalancerAddress: Address;
  inventorySignerAddress?: Address; // Optional - for excluding inventory signer from user transfers query
}

/**
 * ActionTracker implementation managing the lifecycle of tracked entities.
 */
export class ActionTracker implements IActionTracker {
  constructor(
    private readonly transferStore: ITransferStore,
    private readonly rebalanceIntentStore: IRebalanceIntentStore,
    private readonly rebalanceActionStore: IRebalanceActionStore,
    private readonly explorerClient: ExplorerClient,
    private readonly core: HyperlaneCore,
    private readonly config: ActionTrackerConfig,
    private readonly logger: Logger,
  ) {}

  // === Lifecycle ===

  async initialize(): Promise<void> {
    this.logger.info('ActionTracker initializing');

    // Log config for debugging
    this.logger.debug(
      {
        routersByDomain: this.config.routersByDomain,
        bridges: this.config.bridges,
        rebalancerAddress: this.config.rebalancerAddress,
      },
      'ActionTracker config',
    );

    // 1. Startup recovery: query Explorer for inflight rebalance messages
    const inflightMessages =
      await this.explorerClient.getInflightRebalanceActions(
        {
          bridges: this.config.bridges,
          routersByDomain: this.config.routersByDomain,
          rebalancerAddress: this.config.rebalancerAddress,
          inventorySignerAddress: this.config.inventorySignerAddress,
        },
        this.logger,
      );

    this.logger.info(
      { count: inflightMessages.length },
      'Found inflight rebalance messages during startup',
    );

    // 2. For each message, create synthetic intent + action
    for (const msg of inflightMessages) {
      await this.recoverAction(msg);
    }

    // 3. Sync all stores
    await this.syncTransfers();
    await this.syncRebalanceIntents();
    await this.syncRebalanceActions();

    // Log store contents for debugging
    await this.logStoreContents();

    this.logger.info('ActionTracker initialized');
  }

  // === Sync Operations ===

  async syncTransfers(confirmedBlockTags?: ConfirmedBlockTags): Promise<void> {
    this.logger.debug('Syncing transfers');

    // Build list of addresses to exclude (rebalancer + optional inventory signer)
    const excludeTxSenders = [this.config.rebalancerAddress];
    if (this.config.inventorySignerAddress) {
      excludeTxSenders.push(this.config.inventorySignerAddress);
    }

    const inflightMessages = await this.explorerClient.getInflightUserTransfers(
      {
        routersByDomain: this.config.routersByDomain,
        excludeTxSenders,
      },
      this.logger,
    );

    this.logger.debug(
      { count: inflightMessages.length },
      'Received inflight user transfers from Explorer',
    );

    let newTransfers = 0;
    let completedTransfers = 0;

    for (const msg of inflightMessages) {
      const transfer = await this.transferStore.get(msg.msg_id);

      if (!transfer) {
        this.logger.debug(
          {
            msgId: msg.msg_id,
            origin: msg.origin_domain_id,
            destination: msg.destination_domain_id,
            sender: msg.sender,
            recipient: msg.recipient,
            messageBodyLength: msg.message_body?.length,
            messageBodyPreview: msg.message_body?.substring(0, 66),
          },
          'Processing new transfer message',
        );

        try {
          const { amount } = parseWarpRouteMessage(msg.message_body);
          const newTransfer: Transfer = {
            id: msg.msg_id,
            status: 'in_progress',
            messageId: msg.msg_id,
            origin: msg.origin_domain_id,
            destination: msg.destination_domain_id,
            sender: msg.sender,
            recipient: msg.recipient,
            amount,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await this.transferStore.save(newTransfer);
          newTransfers++;
          this.logger.debug(
            { id: newTransfer.id, amount: amount.toString() },
            'Created new transfer',
          );
        } catch (error) {
          this.logger.warn(
            {
              msgId: msg.msg_id,
              messageBody: msg.message_body,
              messageBodyLength: msg.message_body?.length,
              origin: msg.origin_domain_id,
              destination: msg.destination_domain_id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to parse message body, skipping transfer',
          );
        }
      }
    }

    const existingTransfers = await this.getInProgressTransfers();
    for (const transfer of existingTransfers) {
      const chainName = this.core.multiProvider.getChainName(
        transfer.destination,
      );
      const blockTag = confirmedBlockTags?.[chainName];

      const delivered = await this.isMessageDelivered(
        transfer.messageId,
        transfer.destination,
        blockTag,
      );

      if (delivered) {
        await this.transferStore.update(transfer.id, { status: 'complete' });
        completedTransfers++;
        this.logger.debug({ id: transfer.id }, 'Transfer completed');
      }
    }

    const inProgressCount = (await this.getInProgressTransfers()).length;
    this.logger.info(
      {
        newTransfers,
        completed: completedTransfers,
        inProgress: inProgressCount,
      },
      'Transfers synced',
    );
  }

  async syncRebalanceIntents(): Promise<void> {
    this.logger.debug('Syncing rebalance intents');

    // Check in_progress intents for completion by deriving from action states
    const inProgressIntents =
      await this.rebalanceIntentStore.getByStatus('in_progress');
    for (const intent of inProgressIntents) {
      const completedAmount = await this.getCompletedAmountForIntent(intent.id);
      if (completedAmount >= intent.amount) {
        await this.rebalanceIntentStore.update(intent.id, {
          status: 'complete',
        });
        this.logger.debug({ id: intent.id }, 'RebalanceIntent completed');
      }
    }

    this.logger.debug('Rebalance intents synced');
  }

  async syncRebalanceActions(
    confirmedBlockTags?: ConfirmedBlockTags,
  ): Promise<void> {
    this.logger.debug('Syncing rebalance actions');

    let discoveredActions = 0;
    let completedActions = 0;

    const inflightMessages =
      await this.explorerClient.getInflightRebalanceActions(
        {
          bridges: this.config.bridges,
          routersByDomain: this.config.routersByDomain,
          rebalancerAddress: this.config.rebalancerAddress,
          inventorySignerAddress: this.config.inventorySignerAddress,
        },
        this.logger,
      );

    this.logger.debug(
      { count: inflightMessages.length },
      'Found inflight rebalance actions from Explorer',
    );

    const allActions = await this.rebalanceActionStore.getAll();

    for (const msg of inflightMessages) {
      const existingAction = allActions.find((a) => a.messageId === msg.msg_id);

      if (!existingAction) {
        this.logger.info(
          {
            msgId: msg.msg_id,
            origin: msg.origin_domain_id,
            destination: msg.destination_domain_id,
          },
          'Discovered new rebalance action, recovering...',
        );
        await this.recoverAction(msg);
        discoveredActions++;
      }
    }

    // Check delivery status for all in-progress actions in our store
    // Only check delivery for actions that have a messageId (rebalance_message, inventory_deposit)
    // inventory_movement actions are synced separately via LiFi status API
    const inProgressActions =
      await this.rebalanceActionStore.getByStatus('in_progress');
    for (const action of inProgressActions) {
      // Skip actions without messageId (e.g., inventory_movement)
      if (!action.messageId) {
        continue;
      }

      const chainName = this.core.multiProvider.getChainName(
        action.destination,
      );
      const blockTag = confirmedBlockTags?.[chainName];

      const delivered = await this.isMessageDelivered(
        action.messageId,
        action.destination,
        blockTag,
      );

      if (delivered) {
        await this.completeRebalanceAction(action.id);
        completedActions++;
        this.logger.debug({ id: action.id }, 'RebalanceAction completed');
      }
    }

    const inProgressCount = (
      await this.rebalanceActionStore.getByStatus('in_progress')
    ).length;
    this.logger.info(
      {
        discovered: discoveredActions,
        completed: completedActions,
        inProgress: inProgressCount,
      },
      'Actions synced',
    );
  }

  // === Transfer Queries ===

  async getInProgressTransfers(): Promise<Transfer[]> {
    return this.transferStore.getByStatus('in_progress');
  }

  async getTransfersByDestination(destination: Domain): Promise<Transfer[]> {
    return this.transferStore.getByDestination(destination);
  }

  // === RebalanceIntent Queries ===

  async getActiveRebalanceIntents(): Promise<RebalanceIntent[]> {
    // Only return in_progress intents - their origin tx is confirmed
    // so simulation only needs to add to destination (origin already deducted on-chain)
    return this.rebalanceIntentStore.getByStatus('in_progress');
  }

  async getRebalanceIntentsByDestination(
    destination: Domain,
  ): Promise<RebalanceIntent[]> {
    return this.rebalanceIntentStore.getByDestination(destination);
  }

  // === RebalanceIntent Management ===

  async createRebalanceIntent(
    params: CreateRebalanceIntentParams,
  ): Promise<RebalanceIntent> {
    const intent: RebalanceIntent = {
      id: uuidv4(),
      status: 'not_started',
      origin: params.origin,
      destination: params.destination,
      amount: params.amount,
      bridge: params.bridge,
      priority: params.priority,
      strategyType: params.strategyType,
      executionMethod: params.executionMethod,
      originalDeficit: params.originalDeficit,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.rebalanceIntentStore.save(intent);
    this.logger.debug(
      {
        id: intent.id,
        origin: intent.origin,
        destination: intent.destination,
        executionMethod: intent.executionMethod,
      },
      'Created RebalanceIntent',
    );

    return intent;
  }

  async completeRebalanceIntent(id: string): Promise<void> {
    await this.rebalanceIntentStore.update(id, { status: 'complete' });
    this.logger.info({ id }, 'Intent completed');
  }

  async cancelRebalanceIntent(id: string): Promise<void> {
    await this.rebalanceIntentStore.update(id, { status: 'cancelled' });
    this.logger.debug({ id }, 'Cancelled RebalanceIntent');
  }

  async failRebalanceIntent(id: string): Promise<void> {
    await this.rebalanceIntentStore.update(id, { status: 'failed' });
    this.logger.info({ id }, 'Intent failed');
  }

  // === RebalanceAction Management ===

  async createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction> {
    const action: RebalanceAction = {
      id: uuidv4(),
      status: 'in_progress',
      type: params.type,
      intentId: params.intentId,
      messageId: params.messageId,
      txHash: params.txHash,
      bridgeTransferId: params.bridgeTransferId,
      bridgeId: params.bridgeId,
      origin: params.origin,
      destination: params.destination,
      amount: params.amount,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.rebalanceActionStore.save(action);

    // Transition parent intent from not_started to in_progress
    const intent = await this.rebalanceIntentStore.get(params.intentId);
    if (intent && intent.status === 'not_started') {
      await this.rebalanceIntentStore.update(intent.id, {
        status: 'in_progress',
      });
      this.logger.debug(
        { intentId: intent.id },
        'Transitioned RebalanceIntent to in_progress',
      );
    }

    this.logger.debug(
      { id: action.id, intentId: action.intentId, type: action.type },
      'Created RebalanceAction',
    );

    return action;
  }

  async completeRebalanceAction(id: string): Promise<void> {
    const action = await this.rebalanceActionStore.get(id);
    if (!action) {
      throw new Error(`RebalanceAction ${id} not found`);
    }

    await this.rebalanceActionStore.update(id, { status: 'complete' });

    // Check if parent intent is now complete (derive from action states)
    await this.checkAndCompleteIntent(action.intentId);

    this.logger.info(
      { id, intentId: action.intentId, type: action.type },
      'Action completed',
    );
  }

  /**
   * Check if an intent is fully fulfilled based on completed action amounts.
   * Only `inventory_deposit` and `rebalance_message` actions count toward fulfillment.
   */
  private async checkAndCompleteIntent(intentId: string): Promise<void> {
    const intent = await this.rebalanceIntentStore.get(intentId);
    if (!intent || intent.status === 'complete') return;

    const completedAmount = await this.getCompletedAmountForIntent(intentId);

    if (completedAmount >= intent.amount) {
      await this.rebalanceIntentStore.update(intentId, { status: 'complete' });
      this.logger.debug(
        { intentId, completedAmount: completedAmount.toString() },
        'RebalanceIntent fully fulfilled',
      );
    }
  }

  /**
   * Get the total completed amount for an intent from its actions.
   * Only `inventory_deposit` and `rebalance_message` actions count.
   */
  private async getCompletedAmountForIntent(intentId: string): Promise<bigint> {
    const actions = await this.getActionsForIntent(intentId);
    return actions
      .filter(
        (a) =>
          a.status === 'complete' &&
          (a.type === 'inventory_deposit' || a.type === 'rebalance_message'),
      )
      .reduce((sum, a) => sum + a.amount, 0n);
  }

  async failRebalanceAction(id: string): Promise<void> {
    await this.rebalanceActionStore.update(id, { status: 'failed' });
    this.logger.info({ id }, 'Action failed');
  }

  // === RebalanceAction Queries ===

  async getActionsByType(type: ActionType): Promise<RebalanceAction[]> {
    const allActions = await this.rebalanceActionStore.getAll();
    return allActions.filter((action) => action.type === type);
  }

  async getInflightInventoryMovements(origin: Domain): Promise<bigint> {
    const allActions = await this.rebalanceActionStore.getAll();
    const inflightMovements = allActions.filter(
      (action) =>
        action.type === 'inventory_movement' &&
        action.status === 'in_progress' &&
        action.origin === origin,
    );

    return inflightMovements.reduce(
      (sum, action) => sum + action.amount,
      BigInt(0),
    );
  }

  /**
   * Get inventory intents that are in_progress or not_started but not fully fulfilled,
   * and have no in-flight actions (safe to continue).
   * Returns enriched data with computed values derived from action states.
   *
   * NOTE: We include 'not_started' intents because they may have been created
   * but failed to execute (e.g., all bridges failed viability check). Without
   * checking for these, we would create duplicate intents every polling cycle.
   */
  async getPartiallyFulfilledInventoryIntents(): Promise<
    PartialInventoryIntent[]
  > {
    // Query both in_progress AND not_started intents
    // not_started intents may exist if execution failed before any action was created
    const [inProgressIntents, notStartedIntents] = await Promise.all([
      this.rebalanceIntentStore.getByStatus('in_progress'),
      this.rebalanceIntentStore.getByStatus('not_started'),
    ]);

    const allActiveIntents = [...inProgressIntents, ...notStartedIntents];
    const partialIntents: PartialInventoryIntent[] = [];

    for (const intent of allActiveIntents) {
      // Only inventory execution method
      if (intent.executionMethod !== 'inventory') continue;

      const actions = await this.getActionsForIntent(intent.id);

      // Check for in-flight inventory_movement actions
      // Skip intents that have a bridge in progress - wait for it to complete
      const hasInflightMovement = actions.some(
        (a) => a.status === 'in_progress' && a.type === 'inventory_movement',
      );

      if (hasInflightMovement) {
        this.logger.debug(
          { intentId: intent.id },
          'Skipping partial intent - has in-flight inventory movement',
        );
        continue;
      }

      // Compute amounts from action states
      const completedAmount = actions
        .filter(
          (a) => a.status === 'complete' && a.type === 'inventory_deposit',
        )
        .reduce((sum, a) => sum + a.amount, 0n);

      const inflightAmount = actions
        .filter(
          (a) => a.status === 'in_progress' && a.type === 'inventory_deposit',
        )
        .reduce((sum, a) => sum + a.amount, 0n);

      const remaining = intent.amount - completedAmount - inflightAmount;

      // Safe to continue if: remaining > 0 AND no in-flight inventory_deposit
      if (remaining > 0n && inflightAmount === 0n) {
        partialIntents.push({ intent, completedAmount, remaining });
      }
    }

    return partialIntents;
  }

  /**
   * Get all actions associated with a specific intent.
   */
  async getActionsForIntent(intentId: string): Promise<RebalanceAction[]> {
    const allActions = await this.rebalanceActionStore.getAll();
    return allActions.filter((a) => a.intentId === intentId);
  }

  async syncInventoryMovementActions(
    bridge: IExternalBridge,
  ): Promise<{ completed: number; failed: number }> {
    this.logger.debug('Syncing inventory movement actions');

    let completed = 0;
    let failed = 0;

    // Get all in-progress inventory_movement actions
    const inProgressActions =
      await this.rebalanceActionStore.getByStatus('in_progress');
    const inventoryMovements = inProgressActions.filter(
      (a) => a.type === 'inventory_movement',
    );

    this.logger.debug(
      { count: inventoryMovements.length },
      'Found in-progress inventory movements',
    );

    for (const action of inventoryMovements) {
      // Skip if no txHash (shouldn't happen but be safe)
      if (!action.txHash) {
        this.logger.warn(
          { actionId: action.id },
          'Inventory movement action has no txHash',
        );
        continue;
      }

      try {
        const status = await bridge.getStatus(
          action.txHash,
          action.origin,
          action.destination,
        );

        if (status.status === 'complete') {
          await this.completeRebalanceAction(action.id);
          completed++;
          this.logger.info(
            {
              actionId: action.id,
              txHash: action.txHash,
              receivedAmount: status.receivedAmount?.toString(),
            },
            'Inventory movement completed',
          );
        } else if (status.status === 'failed') {
          await this.failRebalanceAction(action.id);
          failed++;
          this.logger.warn(
            {
              actionId: action.id,
              txHash: action.txHash,
              error: status.error,
            },
            'Inventory movement failed',
          );
        } else if (status.status === 'pending') {
          this.logger.debug(
            {
              actionId: action.id,
              txHash: action.txHash,
              substatus: status.substatus,
            },
            'Inventory movement still pending',
          );
        }
        // status === 'not_found' - wait for next cycle
      } catch (error) {
        this.logger.debug(
          {
            actionId: action.id,
            txHash: action.txHash,
            error: (error as Error).message,
          },
          'Failed to get inventory movement status',
        );
      }
    }

    if (inventoryMovements.length > 0) {
      this.logger.info(
        {
          completed,
          failed,
          pending: inventoryMovements.length - completed - failed,
        },
        'Inventory movements synced',
      );
    }

    return { completed, failed };
  }

  // === Debug Helpers ===

  /**
   * Log the contents of all stores.
   * Logs each item separately for full visibility (avoids [Object] truncation).
   */
  async logStoreContents(): Promise<void> {
    const transfers = await this.transferStore.getAll();
    const intents = await this.rebalanceIntentStore.getAll();
    const actions = await this.rebalanceActionStore.getAll();

    const activeIntents = intents.filter((i) =>
      ['not_started', 'in_progress'].includes(i.status),
    );
    const inProgressTransfers = transfers.filter(
      (t) => t.status === 'in_progress',
    );
    const inProgressActions = actions.filter((a) => a.status === 'in_progress');

    // Log summary
    this.logger.info(
      {
        transfers: inProgressTransfers.length,
        intents: activeIntents.length,
        actions: inProgressActions.length,
      },
      'Store summary',
    );

    // Log each transfer separately
    for (const t of inProgressTransfers) {
      this.logger.info(
        {
          type: 'transfer',
          origin: t.origin,
          destination: t.destination,
          amount: t.amount.toString(),
          messageId: t.messageId,
        },
        'In-progress transfer',
      );
    }

    // Log each intent separately
    for (const i of activeIntents) {
      this.logger.info(
        {
          type: 'intent',
          id: i.id,
          origin: i.origin,
          destination: i.destination,
          amount: i.amount.toString(),
          status: i.status,
          bridge: i.bridge,
        },
        'Active intent',
      );
    }

    // Log each action separately
    for (const a of inProgressActions) {
      this.logger.info(
        {
          type: 'action',
          id: a.id,
          origin: a.origin,
          destination: a.destination,
          amount: a.amount.toString(),
          messageId: a.messageId,
          intentId: a.intentId,
        },
        'In-progress action',
      );
    }
  }

  // === Private Helpers ===

  private async getConfirmedBlockTag(
    chainName: string,
  ): Promise<ConfirmedBlockTag> {
    try {
      const metadata = this.core.multiProvider.getChainMetadata(chainName);
      const reorgPeriod = metadata.blocks?.reorgPeriod ?? 32;

      if (typeof reorgPeriod === 'string') {
        return reorgPeriod as ConfirmedBlockTag;
      }

      const provider = this.core.multiProvider.getProvider(chainName);
      const latestBlock = await provider.getBlockNumber();
      return Math.max(0, latestBlock - reorgPeriod);
    } catch (error) {
      this.logger.warn(
        { chain: chainName, error: (error as Error).message },
        'Failed to get confirmed block, using latest',
      );
      return undefined;
    }
  }

  private async isMessageDelivered(
    messageId: string,
    destination: Domain,
    providedBlockTag?: ConfirmedBlockTag,
  ): Promise<boolean> {
    try {
      const chainName = this.core.multiProvider.getChainName(destination);
      const mailbox = this.core.getContracts(chainName).mailbox;

      const blockTag =
        providedBlockTag ?? (await this.getConfirmedBlockTag(chainName));
      const delivered = await mailbox.delivered(messageId, { blockTag });

      this.logger.debug(
        { messageId, destination: chainName, blockTag, delivered },
        'Checked message delivery at confirmed block',
      );

      return delivered;
    } catch (error) {
      this.logger.warn(
        { messageId, destination, error },
        'Failed to check message delivery status',
      );
      return false;
    }
  }

  private async recoverAction(msg: ExplorerMessage): Promise<void> {
    // Check if action already exists
    const existing = await this.rebalanceActionStore.get(msg.msg_id);
    if (existing) {
      this.logger.debug({ id: msg.msg_id }, 'Action already exists, skipping');
      return;
    }

    this.logger.debug(
      {
        msgId: msg.msg_id,
        origin: msg.origin_domain_id,
        destination: msg.destination_domain_id,
        sender: msg.sender,
        recipient: msg.recipient,
        txHash: msg.origin_tx_hash,
        messageBodyLength: msg.message_body?.length,
        messageBodyPreview: msg.message_body?.substring(0, 66),
      },
      'Recovering rebalance action',
    );

    try {
      // Create synthetic intent
      const { amount } = parseWarpRouteMessage(msg.message_body);
      const intent: RebalanceIntent = {
        id: uuidv4(),
        status: 'in_progress',
        origin: msg.origin_domain_id,
        destination: msg.destination_domain_id,
        amount,
        priority: undefined,
        strategyType: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await this.rebalanceIntentStore.save(intent);
      this.logger.debug(
        { id: intent.id, amount: amount.toString() },
        'Created synthetic RebalanceIntent',
      );

      // Create action (recovered actions are always rebalance_message type)
      const action: RebalanceAction = {
        id: msg.msg_id,
        status: 'in_progress',
        type: 'rebalance_message',
        intentId: intent.id,
        messageId: msg.msg_id,
        txHash: msg.origin_tx_hash,
        origin: msg.origin_domain_id,
        destination: msg.destination_domain_id,
        amount,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await this.rebalanceActionStore.save(action);
      this.logger.debug(
        { id: action.id, intentId: action.intentId, amount: amount.toString() },
        'Recovered RebalanceAction',
      );
    } catch (error) {
      this.logger.warn(
        {
          msgId: msg.msg_id,
          messageBody: msg.message_body,
          messageBodyLength: msg.message_body?.length,
          origin: msg.origin_domain_id,
          destination: msg.destination_domain_id,
          txHash: msg.origin_tx_hash,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse message body during recovery, skipping action',
      );
    }
  }
}
