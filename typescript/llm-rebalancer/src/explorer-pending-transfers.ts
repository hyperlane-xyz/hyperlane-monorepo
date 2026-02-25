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
  getInflightTransfers(
    params: {
      routersByDomain: Record<number, string>;
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
  /** All routers per domain (includes all asset warp tokens for multi-asset) */
  private readonly allRoutersByDomain: Record<number, string[]>;

  constructor(
    private explorerClient: ExplorerClientLike,
    agentConfig: RebalancerAgentConfig,
  ) {
    this.allRoutersByDomain = {};
    this.domainToChain = {};
    for (const [name, chain] of Object.entries(agentConfig.chains)) {
      this.domainToChain[chain.domainId] = name;
      const routers: string[] = [chain.warpToken];
      if (chain.assets) {
        for (const asset of Object.values(chain.assets)) {
          if (!routers.includes(asset.warpToken)) {
            routers.push(asset.warpToken);
          }
        }
      }
      this.allRoutersByDomain[chain.domainId] = routers;
    }
  }

  async getPendingTransfers(): Promise<PendingTransfer[]> {
    // Query for each router and merge results (explorer may only accept single router)
    const allMessages: Array<{
      msg_id: string;
      origin_domain_id: number;
      destination_domain_id: number;
      message_body: string;
    }> = [];
    const seenIds = new Set<string>();

    for (const [domainStr, routers] of Object.entries(
      this.allRoutersByDomain,
    )) {
      const domain = Number(domainStr);
      for (const router of routers) {
        const routersByDomain: Record<number, string> = { [domain]: router };
        try {
          const messages = await this.explorerClient.getInflightTransfers(
            { routersByDomain },
            logger,
          );
          for (const msg of messages) {
            if (!seenIds.has(msg.msg_id)) {
              seenIds.add(msg.msg_id);
              allMessages.push(msg);
            }
          }
        } catch (error) {
          logger.warn(
            { domain, router, error },
            'Failed to query explorer for router',
          );
        }
      }
    }

    return allMessages.map((msg) => {
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
