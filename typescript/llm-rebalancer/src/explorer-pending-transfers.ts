/**
 * Explorer-based PendingTransferProvider — queries Hyperlane Explorer API
 * for inflight user transfers, mirroring production RebalancerService behavior.
 */

import { rootLogger } from '@hyperlane-xyz/utils';
import { parseWarpRouteMessage } from '@hyperlane-xyz/utils';

import type { RebalancerAgentConfig } from './config.js';
import type {
  PendingTransfer,
  PendingTransferProvider,
} from './pending-transfers.js';

const logger = rootLogger.child({ module: 'ExplorerPendingTransfers' });

export interface ExplorerClientLike {
  getInflightUserTransfers(
    params: {
      routersByDomain: Record<number, string>;
      excludeTxSender: string;
      limit?: number;
    },
    logger: typeof rootLogger,
  ): Promise<
    Array<{
      msg_id: string;
      origin_domain_id: number;
      destination_domain_id: number;
      message_body: string;
    }>
  >;
}

export class ExplorerPendingTransferProvider implements PendingTransferProvider {
  private readonly domainToChain: Record<number, string>;
  private readonly routersByDomain: Record<number, string>;

  constructor(
    private explorerClient: ExplorerClientLike,
    private agentConfig: RebalancerAgentConfig,
  ) {
    this.routersByDomain = {};
    this.domainToChain = {};
    for (const [name, chain] of Object.entries(agentConfig.chains)) {
      this.routersByDomain[chain.domainId] = chain.warpToken;
      this.domainToChain[chain.domainId] = name;
    }
  }

  async getPendingTransfers(): Promise<PendingTransfer[]> {
    const messages = await this.explorerClient.getInflightUserTransfers(
      {
        routersByDomain: this.routersByDomain,
        excludeTxSender: this.agentConfig.rebalancerAddress,
      },
      logger,
    );

    return messages.map((msg) => {
      const parsed = parseWarpRouteMessage(msg.message_body);
      return {
        messageId: msg.msg_id,
        origin:
          this.domainToChain[msg.origin_domain_id] ??
          String(msg.origin_domain_id),
        destination:
          this.domainToChain[msg.destination_domain_id] ??
          String(msg.destination_domain_id),
        amount: parsed.amount.toString(),
      };
    });
  }
}
