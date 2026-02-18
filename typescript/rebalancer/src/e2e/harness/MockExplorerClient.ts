import type { Logger } from 'pino';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type {
  ExplorerMessage,
  IExplorerClient,
  RebalanceActionQueryParams,
  UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';

import type { ForkIndexer } from './ForkIndexer.js';

export interface MockExplorerConfig {
  userTransfers?: ExplorerMessage[];
  rebalanceActions?: ExplorerMessage[];
}

export class MockExplorerClient implements IExplorerClient {
  private userTransfers: ExplorerMessage[];
  private rebalanceActions: ExplorerMessage[];

  constructor(
    config: MockExplorerConfig = {},
    private readonly forkIndexer?: ForkIndexer,
    private readonly getBlockTags?: () => Promise<ConfirmedBlockTags>,
  ) {
    this.userTransfers = config.userTransfers ?? [];
    this.rebalanceActions = config.rebalanceActions ?? [];
  }

  async getInflightUserTransfers(
    _params: UserTransferQueryParams,
    _logger?: Logger,
  ): Promise<ExplorerMessage[]> {
    if (this.forkIndexer && this.getBlockTags) {
      await this.forkIndexer.sync(await this.getBlockTags());
      const indexedTransfers = this.forkIndexer
        .getUserTransfers()
        .filter((msg) => !msg.is_delivered);
      const configTransfers = this.userTransfers.filter(
        (msg) => !msg.is_delivered,
      );
      return [...configTransfers, ...indexedTransfers];
    }
    return this.userTransfers.filter((msg) => !msg.is_delivered);
  }

  async getInflightRebalanceActions(
    _params: RebalanceActionQueryParams,
    _logger?: Logger,
  ): Promise<ExplorerMessage[]> {
    if (this.forkIndexer && this.getBlockTags) {
      await this.forkIndexer.sync(await this.getBlockTags());
      const indexedActions = this.forkIndexer
        .getRebalanceActions()
        .filter((msg) => !msg.is_delivered);
      const configActions = this.rebalanceActions.filter(
        (msg) => !msg.is_delivered,
      );
      return [...configActions, ...indexedActions];
    }
    return this.rebalanceActions.filter((msg) => !msg.is_delivered);
  }

  addUserTransfer(transfer: ExplorerMessage): void {
    this.userTransfers.push(transfer);
  }

  addRebalanceAction(action: ExplorerMessage): void {
    this.rebalanceActions.push(action);
  }

  updateTransfer(messageId: string, updates: Partial<ExplorerMessage>): void {
    const transfer = this.userTransfers.find((t) => t.msg_id === messageId);
    if (transfer) {
      Object.assign(transfer, updates);
    }
  }

  updateRebalanceAction(
    messageId: string,
    updates: Partial<ExplorerMessage>,
  ): void {
    const action = this.rebalanceActions.find((a) => a.msg_id === messageId);
    if (action) {
      Object.assign(action, updates);
    }
  }

  clearAll(): void {
    this.userTransfers.length = 0;
    this.rebalanceActions.length = 0;
  }
}
