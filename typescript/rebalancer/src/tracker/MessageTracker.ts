import type { Logger } from 'pino';

import type { ChainMap, ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

import type { RebalancingRoute } from '../interfaces/IStrategy.js';

/**
 * Represents an inflight message (either a user transfer or a rebalance)
 */
export type InflightMessage = {
  id: string;
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  sender: string;
  recipient: string;
  isRebalance: boolean;
  timestamp: number;
};

/**
 * Context containing inflight messages for strategy decision making
 */
export type InflightContext = {
  /** Pending user warp transfers */
  pendingTransfers: RebalancingRoute[];
  /** Pending rebalances (initiated by rebalancer or manually) */
  pendingRebalances: RebalancingRoute[];
};

export type MessageTrackerConfig = {
  /** Explorer GraphQL API URL */
  explorerUrl: string;
  /** Warp route token addresses by chain */
  routerAddresses: ChainMap<string>;
  /** Bridge addresses by chain (for rebalance detection) */
  bridgeAddresses: ChainMap<string>;
  /** Domain IDs for each chain */
  domainIds: ChainMap<number>;
  /** Mailbox addresses by chain (for delivery verification) */
  mailboxAddresses: ChainMap<string>;
  /** Address of the rebalancer (tx sender for rebalances) */
  rebalancerAddress: string;
};

/**
 * MessageTracker tracks all actions relevant to rebalancing operations,
 * including both Hyperlane messages and external actions.
 *
 * Data sources:
 * 1. Rebalancer internal action tracking - tracks rebalances initiated by this rebalancer
 * 2. Explorer GraphQL API - queries user warp transfers and pending rebalances
 * 3. On-chain verification - verifies message delivery status
 */
export class MessageTracker {
  private readonly logger: Logger;
  private readonly config: MessageTrackerConfig;
  private readonly multiProvider: MultiProvider;

  // In-memory cache of pending rebalances initiated by this rebalancer
  private pendingRebalancesCache: Map<string, InflightMessage> = new Map();

  constructor(
    config: MessageTrackerConfig,
    multiProvider: MultiProvider,
    logger: Logger,
  ) {
    this.config = config;
    this.multiProvider = multiProvider;
    this.logger = logger.child({ component: 'MessageTracker' });
  }

  /**
   * Get the current inflight context for strategy decision making
   */
  async getInflightContext(): Promise<InflightContext> {
    this.logger.debug('Fetching inflight context');

    const [pendingTransfers, pendingRebalances] = await Promise.all([
      this.fetchPendingTransfers(),
      this.fetchPendingRebalances(),
    ]);

    this.logger.info(
      {
        pendingTransfersCount: pendingTransfers.length,
        pendingRebalancesCount: pendingRebalances.length,
      },
      'Inflight context fetched',
    );

    return {
      pendingTransfers,
      pendingRebalances,
    };
  }

  /**
   * Record a rebalance that was just initiated by the rebalancer
   */
  recordInitiatedRebalance(route: RebalancingRoute, messageId: string): void {
    const message: InflightMessage = {
      id: messageId,
      origin: route.origin,
      destination: route.destination,
      amount: route.amount,
      sender: this.config.bridgeAddresses[route.origin] ?? '',
      recipient: this.config.bridgeAddresses[route.destination] ?? '',
      isRebalance: true,
      timestamp: Date.now(),
    };

    this.pendingRebalancesCache.set(messageId, message);
    this.logger.debug(
      { messageId, route },
      'Recorded initiated rebalance in cache',
    );
  }

  /**
   * Fetch pending user warp transfers from Explorer API and verify delivery
   */
  private async fetchPendingTransfers(): Promise<RebalancingRoute[]> {
    const routerAddresses = Object.values(this.config.routerAddresses);
    const domains = Object.values(this.config.domainIds);

    if (routerAddresses.length === 0 || domains.length === 0) {
      this.logger.warn('No router addresses or domains configured');
      return [];
    }

    try {
      const messages = await this.queryExplorerForTransfers(
        routerAddresses,
        domains,
      );

      // Filter out delivered messages
      const undelivered = await this.filterDeliveredMessages(messages);

      return undelivered.map((msg) => ({
        origin: msg.origin,
        destination: msg.destination,
        amount: msg.amount,
      }));
    } catch (error) {
      this.logger.error({ error }, 'Failed to fetch pending transfers');
      return [];
    }
  }

  /**
   * Fetch pending rebalances from both cache and Explorer API
   */
  private async fetchPendingRebalances(): Promise<RebalancingRoute[]> {
    const bridgeAddresses = Object.values(this.config.bridgeAddresses);
    const domains = Object.values(this.config.domainIds);

    if (bridgeAddresses.length === 0) {
      return [];
    }

    try {
      // Get rebalances from Explorer (includes manual rebalances)
      const explorerRebalances = await this.queryExplorerForRebalances(
        bridgeAddresses,
        domains,
      );

      // Get rebalances from internal cache
      const cachedRebalances = Array.from(this.pendingRebalancesCache.values());

      // Combine and deduplicate by message ID
      const allRebalances = new Map<string, InflightMessage>();

      for (const msg of explorerRebalances) {
        allRebalances.set(msg.id, msg);
      }

      for (const msg of cachedRebalances) {
        if (!allRebalances.has(msg.id)) {
          allRebalances.set(msg.id, msg);
        }
      }

      // Verify delivery and evict delivered messages from cache
      const undelivered = await this.filterDeliveredMessages(
        Array.from(allRebalances.values()),
      );

      // Update cache - remove delivered messages
      const undeliveredIds = new Set(undelivered.map((m) => m.id));
      for (const id of this.pendingRebalancesCache.keys()) {
        if (!undeliveredIds.has(id)) {
          this.pendingRebalancesCache.delete(id);
          this.logger.debug(
            { messageId: id },
            'Evicted delivered rebalance from cache',
          );
        }
      }

      return undelivered.map((msg) => ({
        origin: msg.origin,
        destination: msg.destination,
        amount: msg.amount,
      }));
    } catch (error) {
      this.logger.error({ error }, 'Failed to fetch pending rebalances');

      // Fall back to cache only
      return Array.from(this.pendingRebalancesCache.values()).map((msg) => ({
        origin: msg.origin,
        destination: msg.destination,
        amount: msg.amount,
      }));
    }
  }

  /**
   * Query Explorer GraphQL API for user warp transfers
   */
  private async queryExplorerForTransfers(
    routerAddresses: string[],
    domains: number[],
  ): Promise<InflightMessage[]> {
    const query = `
      query PendingWarpTransfers(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $limit: Int = 100
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } }
            ]
          }
          order_by: { origin_tx_id: desc }
          limit: $limit
        ) {
          msg_id
          origin_domain_id
          destination_domain_id
          sender
          recipient
          origin_tx_hash
          send_occurred_at
          message_body
        }
      }
    `;

    const variables = {
      senders: routerAddresses.map((a) => this.toBytea(a)),
      recipients: routerAddresses.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      limit: 100,
    };

    const result = await this.executeExplorerQuery(query, variables);
    return this.parseExplorerMessages(result, false);
  }

  /**
   * Query Explorer GraphQL API for rebalance messages
   */
  private async queryExplorerForRebalances(
    bridgeAddresses: string[],
    domains: number[],
  ): Promise<InflightMessage[]> {
    const query = `
      query PendingRebalances(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $limit: Int = 50
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } }
            ]
          }
          order_by: { origin_tx_id: desc }
          limit: $limit
        ) {
          msg_id
          origin_domain_id
          destination_domain_id
          sender
          recipient
          origin_tx_hash
          send_occurred_at
          message_body
        }
      }
    `;

    const variables = {
      senders: bridgeAddresses.map((a) => this.toBytea(a)),
      recipients: bridgeAddresses.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      limit: 50,
    };

    const result = await this.executeExplorerQuery(query, variables);
    return this.parseExplorerMessages(result, true);
  }

  /**
   * Execute a GraphQL query against the Explorer API
   */
  private async executeExplorerQuery(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown[]> {
    const res = await fetch(this.config.explorerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`Explorer query failed: ${res.status}`);
    }

    const json = await res.json();
    return json?.data?.message_view ?? [];
  }

  /**
   * Parse Explorer API response into InflightMessage objects
   */
  private parseExplorerMessages(
    rows: unknown[],
    isRebalance: boolean,
  ): InflightMessage[] {
    const chainByDomainId = this.getChainByDomainId();

    return rows
      .map((row: any) => {
        const originChain = chainByDomainId.get(row.origin_domain_id);
        const destChain = chainByDomainId.get(row.destination_domain_id);

        if (!originChain || !destChain) {
          this.logger.warn(
            { row },
            'Could not resolve chain names for message',
          );
          return null;
        }

        // Parse amount from message body if available
        const amount = this.parseAmountFromMessageBody(row.message_body);

        return {
          id: row.msg_id,
          origin: originChain,
          destination: destChain,
          amount,
          sender: row.sender,
          recipient: row.recipient,
          isRebalance,
          timestamp: row.send_occurred_at
            ? new Date(row.send_occurred_at).getTime()
            : Date.now(),
        };
      })
      .filter((msg): msg is InflightMessage => msg !== null);
  }

  /**
   * Filter out messages that have been delivered on-chain
   */
  private async filterDeliveredMessages(
    messages: InflightMessage[],
  ): Promise<InflightMessage[]> {
    if (messages.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      messages.map(async (msg) => {
        const isDelivered = await this.checkMessageDelivered(msg);
        return { msg, isDelivered };
      }),
    );

    return results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          msg: InflightMessage;
          isDelivered: boolean;
        }> => r.status === 'fulfilled' && !r.value.isDelivered,
      )
      .map((r) => r.value.msg);
  }

  /**
   * Check if a message has been delivered on-chain
   */
  private async checkMessageDelivered(msg: InflightMessage): Promise<boolean> {
    try {
      const provider = this.multiProvider.getProvider(msg.destination);
      const mailboxAddress = this.config.mailboxAddresses[msg.destination];

      if (!mailboxAddress) {
        this.logger.warn(
          { chain: msg.destination },
          'No mailbox address found for chain',
        );
        return false;
      }

      // Call mailbox.delivered(messageId)
      const mailboxInterface = new (await import('ethers')).utils.Interface([
        'function delivered(bytes32 messageId) view returns (bool)',
      ]);

      const data = mailboxInterface.encodeFunctionData('delivered', [msg.id]);
      const result = await provider.call({
        to: mailboxAddress,
        data,
      });

      const [delivered] = mailboxInterface.decodeFunctionResult(
        'delivered',
        result,
      );
      return delivered as boolean;
    } catch (error) {
      this.logger.debug(
        { error, messageId: msg.id },
        'Failed to check message delivery status',
      );
      // Assume not delivered if check fails
      return false;
    }
  }

  /**
   * Parse transfer amount from Hyperlane message body
   * The message body for warp transfers typically contains the amount
   */
  private parseAmountFromMessageBody(messageBody: string | null): bigint {
    if (!messageBody) {
      return 0n;
    }

    try {
      // Remove '\\x' prefix if present and convert to hex
      const hex = messageBody.replace(/^\\x/, '0x');

      // Warp route message format: first 32 bytes is the amount
      if (hex.length >= 66) {
        // 0x + 64 hex chars
        const amountHex = hex.slice(0, 66);
        return BigInt(amountHex);
      }

      return 0n;
    } catch {
      return 0n;
    }
  }

  /**
   * Convert address to PostgreSQL bytea format
   */
  private toBytea(addr: string): string {
    return addr.replace(/^0x/i, '\\x').toLowerCase();
  }

  /**
   * Get a mapping of domain IDs to chain names
   */
  private getChainByDomainId(): Map<number, ChainName> {
    const map = new Map<number, ChainName>();
    for (const [chain, domainId] of Object.entries(this.config.domainIds)) {
      map.set(domainId, chain);
    }
    return map;
  }
}
