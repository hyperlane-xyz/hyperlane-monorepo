import type { Logger } from 'pino';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import type {
  InflightContext,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

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

export type MessageTrackerConfig = {
  /** Explorer GraphQL API URL */
  explorerUrl: string;
  /** Warp route token addresses by chain (routers for user transfers) */
  routerAddresses: ChainMap<string>;
  /** Bridge addresses by chain (for rebalance detection) */
  bridgeAddresses: ChainMap<string>;
  /** Domain IDs for each chain */
  domainIds: ChainMap<number>;
};

/**
 * MessageTracker tracks inflight Hyperlane messages for rebalancing decisions.
 *
 * Data sources:
 * 1. Explorer GraphQL API - queries pending warp transfers and rebalances
 * 2. Internal cache - tracks rebalances initiated by this rebalancer
 */
export class MessageTracker {
  private readonly logger: Logger;
  private readonly config: MessageTrackerConfig;

  // In-memory cache of pending rebalances initiated by this rebalancer
  private pendingRebalancesCache: Map<string, InflightMessage> = new Map();

  constructor(config: MessageTrackerConfig, logger: Logger) {
    this.config = config;
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
   * Record a rebalance that was just initiated by the rebalancer.
   * This allows the tracker to include it in the inflight context before
   * it appears in the Explorer API.
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
   * Fetch pending user warp transfers from Explorer API
   */
  private async fetchPendingTransfers(): Promise<RebalancingRoute[]> {
    const routerAddresses = Object.values(this.config.routerAddresses);
    const domains = Object.values(this.config.domainIds);

    if (routerAddresses.length === 0 || domains.length === 0) {
      this.logger.warn('No router addresses or domains configured');
      return [];
    }

    try {
      const messages = await this.queryExplorerForMessages(
        routerAddresses,
        routerAddresses, // Recipients are also routers for warp transfers
        domains,
        100,
      );

      return messages.map((msg) => ({
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
      // Fall back to cache only
      return Array.from(this.pendingRebalancesCache.values()).map((msg) => ({
        origin: msg.origin,
        destination: msg.destination,
        amount: msg.amount,
      }));
    }

    try {
      // Get rebalances from Explorer
      const explorerRebalances = await this.queryExplorerForMessages(
        bridgeAddresses,
        bridgeAddresses, // Recipients are also bridges for rebalances
        domains,
        50,
      );

      // Combine with internal cache and deduplicate by message ID
      const allRebalances = new Map<string, InflightMessage>();

      for (const msg of explorerRebalances) {
        allRebalances.set(msg.id, msg);
      }

      for (const msg of this.pendingRebalancesCache.values()) {
        if (!allRebalances.has(msg.id)) {
          allRebalances.set(msg.id, msg);
        }
      }

      // Evict delivered messages from cache
      // (If a message is no longer in Explorer results, it's likely delivered)
      const explorerIds = new Set(explorerRebalances.map((m) => m.id));
      for (const id of this.pendingRebalancesCache.keys()) {
        // Only evict if message is old enough (> 5 min) and not in Explorer
        const cached = this.pendingRebalancesCache.get(id);
        const ageMs = Date.now() - (cached?.timestamp ?? 0);
        if (!explorerIds.has(id) && ageMs > 5 * 60 * 1000) {
          this.pendingRebalancesCache.delete(id);
          this.logger.debug(
            { messageId: id },
            'Evicted delivered rebalance from cache',
          );
        }
      }

      return Array.from(allRebalances.values()).map((msg) => ({
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
   * Query Explorer GraphQL API for pending messages
   */
  private async queryExplorerForMessages(
    senders: string[],
    recipients: string[],
    domains: number[],
    limit: number,
  ): Promise<InflightMessage[]> {
    const query = `
      query PendingMessages(
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
          send_occurred_at
          message_body
        }
      }
    `;

    const variables = {
      senders: senders.map((a) => this.toBytea(a)),
      recipients: recipients.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      limit,
    };

    const result = await this.executeExplorerQuery(query, variables);
    return this.parseExplorerMessages(result);
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

    const json = (await res.json()) as {
      data?: { message_view?: unknown[] };
      errors?: unknown[];
    };

    if (json.errors) {
      this.logger.warn(
        { errors: json.errors },
        'Explorer query returned errors',
      );
    }

    return json?.data?.message_view ?? [];
  }

  /**
   * Parse Explorer API response into InflightMessage objects
   */
  private parseExplorerMessages(rows: unknown[]): InflightMessage[] {
    const chainByDomainId = this.getChainByDomainId();

    return rows
      .map((row: any) => {
        const originChain = chainByDomainId.get(row.origin_domain_id);
        const destChain = chainByDomainId.get(row.destination_domain_id);

        if (!originChain || !destChain) {
          this.logger.debug(
            {
              originDomain: row.origin_domain_id,
              destDomain: row.destination_domain_id,
            },
            'Could not resolve chain names for message, skipping',
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
          isRebalance: false, // Will be determined by caller context
          timestamp: row.send_occurred_at
            ? new Date(row.send_occurred_at).getTime()
            : Date.now(),
        };
      })
      .filter((msg): msg is InflightMessage => msg !== null);
  }

  /**
   * Parse transfer amount from Hyperlane message body.
   * The message body for warp transfers typically contains the amount as the first 32 bytes.
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
