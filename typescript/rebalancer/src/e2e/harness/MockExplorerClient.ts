import type { Logger } from 'pino';

import type {
  ExplorerMessage,
  IExplorerClient,
  RebalanceActionQueryParams,
  UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';

export interface MockExplorerConfig {
  userTransfers?: ExplorerMessage[];
  rebalanceActions?: ExplorerMessage[];
}

export class MockExplorerClient implements IExplorerClient {
  private userTransfers: ExplorerMessage[];
  private rebalanceActions: ExplorerMessage[];

  constructor(config: MockExplorerConfig = {}) {
    this.userTransfers = config.userTransfers ?? [];
    this.rebalanceActions = config.rebalanceActions ?? [];
  }

  async getInflightUserTransfers(
    _params: UserTransferQueryParams,
    _logger?: Logger,
  ): Promise<ExplorerMessage[]> {
    return this.userTransfers.filter((msg) => !msg.is_delivered);
  }

  async getInflightRebalanceActions(
    _params: RebalanceActionQueryParams,
    _logger?: Logger,
  ): Promise<ExplorerMessage[]> {
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
