import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type { HyperlaneCore } from '@hyperlane-xyz/sdk';
import type { Address, Domain } from '@hyperlane-xyz/utils';
import { parseWarpRouteMessage } from '@hyperlane-xyz/utils';

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
  IRebalanceActionStore,
  IRebalanceIntentStore,
  ITransferStore,
  RebalanceAction,
  RebalanceIntent,
  Transfer,
} from './types.js';

export interface ActionTrackerConfig {
  routers: Address[]; // Warp route router addresses for user transfer queries
  bridges: Address[]; // Bridge contract addresses for rebalance action queries
  rebalancerAddress: Address;
  domains: number[];
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

    // 1. Startup recovery: query Explorer for inflight rebalance messages
    const inflightMessages =
      await this.explorerClient.getInflightRebalanceActions(
        {
          bridges: this.config.bridges,
          domains: this.config.domains,
          rebalancerAddress: this.config.rebalancerAddress,
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

    this.logger.info('ActionTracker initialized');
  }

  // === Sync Operations ===

  async syncTransfers(): Promise<void> {
    this.logger.debug('Syncing transfers');

    // Query Explorer for inflight user transfers
    const inflightMessages = await this.explorerClient.getInflightUserTransfers(
      {
        routers: this.config.routers,
        domains: this.config.domains,
        excludeTxSender: this.config.rebalancerAddress,
      },
      this.logger,
    );

    this.logger.debug(
      { count: inflightMessages.length },
      'Received inflight user transfers from Explorer',
    );

    // Process each message from Explorer
    for (const msg of inflightMessages) {
      const transfer = await this.transferStore.get(msg.msg_id);

      if (!transfer) {
        // New transfer, create it
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

    // Check existing transfers for delivery
    const existingTransfers = await this.getInProgressTransfers();
    for (const transfer of existingTransfers) {
      const delivered = await this.isMessageDelivered(
        transfer.messageId,
        transfer.destination,
      );

      if (delivered) {
        await this.transferStore.update(transfer.id, { status: 'complete' });
        this.logger.debug({ id: transfer.id }, 'Transfer completed');
      }
    }

    this.logger.debug('Transfers synced');
  }

  async syncRebalanceIntents(): Promise<void> {
    this.logger.debug('Syncing rebalance intents');

    // Check in_progress intents for completion
    const inProgressIntents =
      await this.rebalanceIntentStore.getByStatus('in_progress');
    for (const intent of inProgressIntents) {
      if (intent.fulfilledAmount >= intent.amount) {
        await this.rebalanceIntentStore.update(intent.id, {
          status: 'complete',
        });
        this.logger.debug({ id: intent.id }, 'RebalanceIntent completed');
      }
    }

    this.logger.debug('Rebalance intents synced');
  }

  async syncRebalanceActions(): Promise<void> {
    this.logger.debug('Syncing rebalance actions');

    // 1. Query Explorer for ALL inflight rebalance actions (including manual ones)
    const inflightMessages =
      await this.explorerClient.getInflightRebalanceActions(
        {
          bridges: this.config.bridges,
          domains: this.config.domains,
          rebalancerAddress: this.config.rebalancerAddress,
        },
        this.logger,
      );

    this.logger.debug(
      { count: inflightMessages.length },
      'Found inflight rebalance actions from Explorer',
    );

    // 2. For each message from Explorer, check if it exists in our store
    for (const msg of inflightMessages) {
      const existingAction = await this.rebalanceActionStore.get(msg.msg_id);

      if (!existingAction) {
        // New action (manual rebalance or restart gap) - recover it
        this.logger.info(
          {
            msgId: msg.msg_id,
            origin: msg.origin_domain_id,
            destination: msg.destination_domain_id,
          },
          'Discovered new rebalance action, recovering...',
        );
        await this.recoverAction(msg);
      }
    }

    // 3. Check delivery status for all in-progress actions in our store
    const inProgressActions =
      await this.rebalanceActionStore.getByStatus('in_progress');
    for (const action of inProgressActions) {
      const delivered = await this.isMessageDelivered(
        action.messageId,
        action.destination,
      );

      if (delivered) {
        await this.completeRebalanceAction(action.id);
        this.logger.debug({ id: action.id }, 'RebalanceAction completed');
      }
    }

    this.logger.debug('Rebalance actions synced');
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
    const notStarted =
      await this.rebalanceIntentStore.getByStatus('not_started');
    const inProgress =
      await this.rebalanceIntentStore.getByStatus('in_progress');
    return [...notStarted, ...inProgress];
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
      fulfilledAmount: 0n,
      priority: params.priority,
      strategyType: params.strategyType,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.rebalanceIntentStore.save(intent);
    this.logger.debug(
      { id: intent.id, origin: intent.origin, destination: intent.destination },
      'Created RebalanceIntent',
    );

    return intent;
  }

  async completeRebalanceIntent(id: string): Promise<void> {
    await this.rebalanceIntentStore.update(id, { status: 'complete' });
    this.logger.debug({ id }, 'Completed RebalanceIntent');
  }

  async cancelRebalanceIntent(id: string): Promise<void> {
    await this.rebalanceIntentStore.update(id, { status: 'cancelled' });
    this.logger.debug({ id }, 'Cancelled RebalanceIntent');
  }

  // === RebalanceAction Management ===

  async createRebalanceAction(
    params: CreateRebalanceActionParams,
  ): Promise<RebalanceAction> {
    const action: RebalanceAction = {
      id: uuidv4(),
      status: 'in_progress',
      intentId: params.intentId,
      messageId: params.messageId,
      txHash: params.txHash,
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
      { id: action.id, intentId: action.intentId },
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

    // Update parent intent's fulfilledAmount
    const intent = await this.rebalanceIntentStore.get(action.intentId);
    if (intent) {
      const newFulfilledAmount = intent.fulfilledAmount + action.amount;
      const updates: Partial<RebalanceIntent> = {
        fulfilledAmount: newFulfilledAmount,
      };

      // Check if intent is now complete
      if (newFulfilledAmount >= intent.amount) {
        updates.status = 'complete';
        this.logger.debug(
          { intentId: intent.id },
          'RebalanceIntent fully fulfilled',
        );
      }

      await this.rebalanceIntentStore.update(intent.id, updates);
    }

    this.logger.debug({ id }, 'Completed RebalanceAction');
  }

  async failRebalanceAction(id: string): Promise<void> {
    await this.rebalanceActionStore.update(id, { status: 'failed' });
    this.logger.debug({ id }, 'Failed RebalanceAction');
  }

  // === Private Helpers ===

  private async isMessageDelivered(
    messageId: string,
    destination: Domain,
  ): Promise<boolean> {
    try {
      const chainName = this.core.multiProvider.getChainName(destination);
      const mailbox = this.core.getContracts(chainName).mailbox;
      return await mailbox.delivered(messageId);
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
        fulfilledAmount: 0n,
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

      // Create action
      const action: RebalanceAction = {
        id: msg.msg_id,
        status: 'in_progress',
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
