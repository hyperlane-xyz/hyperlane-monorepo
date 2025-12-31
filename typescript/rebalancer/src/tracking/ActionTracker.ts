import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type { HyperlaneCore } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

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
  routers: Address[];
  rebalancerAddress: Address;
  domains: number[];
}

/**
 * ActionTracker implementation managing the lifecycle of tracked entities.
 */
export class ActionTracker implements IActionTracker {
  constructor(
    private readonly transferStore: ITransferStore,
    private readonly intentStore: IRebalanceIntentStore,
    private readonly actionStore: IRebalanceActionStore,
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
          routers: this.config.routers,
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

    // Process each message from Explorer
    for (const msg of inflightMessages) {
      const transfer = await this.transferStore.get(msg.msg_id);

      if (!transfer) {
        // New transfer, create it
        const newTransfer: Transfer = {
          id: msg.msg_id,
          status: 'in_progress',
          messageId: msg.msg_id,
          origin: this.domainToChain(msg.origin_domain_id),
          destination: this.domainToChain(msg.destination_domain_id),
          sender: msg.sender,
          recipient: msg.recipient,
          amount: 0n, // We don't have amount from Explorer
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await this.transferStore.save(newTransfer);
        this.logger.debug({ id: newTransfer.id }, 'Created new transfer');
      }
    }

    // Check existing transfers for delivery
    const existingTransfers =
      await this.transferStore.getByStatus('in_progress');
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
    const inProgressIntents = await this.intentStore.getByStatus('in_progress');
    for (const intent of inProgressIntents) {
      if (intent.fulfilledAmount >= intent.amount) {
        await this.intentStore.update(intent.id, { status: 'complete' });
        this.logger.debug({ id: intent.id }, 'RebalanceIntent completed');
      }
    }

    this.logger.debug('Rebalance intents synced');
  }

  async syncRebalanceActions(): Promise<void> {
    this.logger.debug('Syncing rebalance actions');

    const inProgressActions = await this.actionStore.getByStatus('in_progress');
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

  async getTransfersByDestination(destination: string): Promise<Transfer[]> {
    return this.transferStore.getByDestination(destination);
  }

  // === RebalanceIntent Queries ===

  async getActiveRebalanceIntents(): Promise<RebalanceIntent[]> {
    const notStarted = await this.intentStore.getByStatus('not_started');
    const inProgress = await this.intentStore.getByStatus('in_progress');
    return [...notStarted, ...inProgress];
  }

  async getRebalanceIntentsByDestination(
    destination: string,
  ): Promise<RebalanceIntent[]> {
    return this.intentStore.getByDestination(destination);
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

    await this.intentStore.save(intent);
    this.logger.debug(
      { id: intent.id, origin: intent.origin, destination: intent.destination },
      'Created RebalanceIntent',
    );

    return intent;
  }

  async completeRebalanceIntent(id: string): Promise<void> {
    await this.intentStore.update(id, { status: 'complete' });
    this.logger.debug({ id }, 'Completed RebalanceIntent');
  }

  async cancelRebalanceIntent(id: string): Promise<void> {
    await this.intentStore.update(id, { status: 'cancelled' });
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

    await this.actionStore.save(action);

    // Transition parent intent from not_started to in_progress
    const intent = await this.intentStore.get(params.intentId);
    if (intent && intent.status === 'not_started') {
      await this.intentStore.update(intent.id, { status: 'in_progress' });
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
    const action = await this.actionStore.get(id);
    if (!action) {
      throw new Error(`RebalanceAction ${id} not found`);
    }

    await this.actionStore.update(id, { status: 'complete' });

    // Update parent intent's fulfilledAmount
    const intent = await this.intentStore.get(action.intentId);
    if (intent) {
      const newFulfilledAmount = intent.fulfilledAmount + action.amount;
      await this.intentStore.update(intent.id, {
        fulfilledAmount: newFulfilledAmount,
      });

      // Check if intent is now complete
      if (newFulfilledAmount >= intent.amount) {
        await this.intentStore.update(intent.id, { status: 'complete' });
        this.logger.debug(
          { intentId: intent.id },
          'RebalanceIntent fully fulfilled',
        );
      }
    }

    this.logger.debug({ id }, 'Completed RebalanceAction');
  }

  async failRebalanceAction(id: string): Promise<void> {
    await this.actionStore.update(id, { status: 'failed' });
    this.logger.debug({ id }, 'Failed RebalanceAction');
  }

  // === Private Helpers ===

  private async isMessageDelivered(
    messageId: string,
    destination: string,
  ): Promise<boolean> {
    try {
      const mailbox = this.core.getContracts(destination).mailbox;
      return await mailbox.delivered(messageId);
    } catch (error) {
      this.logger.warn(
        { messageId, destination, error },
        'Failed to check message delivery status',
      );
      return false;
    }
  }

  private domainToChain(domainId: number): string {
    // TODO: Implement proper domain-to-chain mapping
    // For now, return domain ID as string
    return domainId.toString();
  }

  private async recoverAction(msg: ExplorerMessage): Promise<void> {
    // Check if action already exists
    const existing = await this.actionStore.get(msg.msg_id);
    if (existing) {
      this.logger.debug({ id: msg.msg_id }, 'Action already exists, skipping');
      return;
    }

    // Create synthetic intent
    const intent: RebalanceIntent = {
      id: uuidv4(),
      status: 'in_progress',
      origin: this.domainToChain(msg.origin_domain_id),
      destination: this.domainToChain(msg.destination_domain_id),
      amount: 0n, // We don't have amount from Explorer
      fulfilledAmount: 0n,
      priority: undefined,
      strategyType: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.intentStore.save(intent);
    this.logger.debug({ id: intent.id }, 'Created synthetic RebalanceIntent');

    // Create action
    const action: RebalanceAction = {
      id: msg.msg_id,
      status: 'in_progress',
      intentId: intent.id,
      messageId: msg.msg_id,
      txHash: msg.origin_tx_hash,
      origin: this.domainToChain(msg.origin_domain_id),
      destination: this.domainToChain(msg.destination_domain_id),
      amount: 0n, // We don't have amount from Explorer
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.actionStore.save(action);
    this.logger.debug(
      { id: action.id, intentId: action.intentId },
      'Recovered RebalanceAction',
    );
  }
}
