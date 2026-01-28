import type { Logger } from 'pino';

export type InflightRebalanceQueryParams = {
  bridges: string[];
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  txSender: string;
  limit?: number;
};

export type UserTransferQueryParams = {
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  excludeTxSender: string; // Rebalancer address to exclude
  limit?: number;
};

export type RebalanceActionQueryParams = {
  bridges: string[]; // Bridge contract addresses
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  rebalancerAddress: string; // Only include rebalancer's txs
  limit?: number;
};

export type ExplorerMessage = {
  msg_id: string;
  origin_domain_id: number;
  destination_domain_id: number;
  sender: string;
  recipient: string;
  origin_tx_hash: string;
  origin_tx_sender: string;
  origin_tx_recipient: string;
  is_delivered: boolean;
  message_body: string;
};

export class ExplorerClient {
  constructor(private readonly baseUrl: string) {}

  private toBytea(addr: string): string {
    return addr.replace(/^0x/i, '\\x').toLowerCase();
  }

  /**
   * Normalize all hex fields in Explorer response from PostgreSQL bytea format (\\x) to standard hex (0x)
   */
  private normalizeExplorerMessage(msg: any): ExplorerMessage {
    const normalizeHex = (hex: string): string => {
      if (!hex) return hex;
      return hex.startsWith('\\x') ? '0x' + hex.slice(2) : hex;
    };

    return {
      msg_id: normalizeHex(msg.msg_id),
      origin_domain_id: msg.origin_domain_id,
      destination_domain_id: msg.destination_domain_id,
      sender: normalizeHex(msg.sender),
      recipient: normalizeHex(msg.recipient),
      origin_tx_hash: normalizeHex(msg.origin_tx_hash),
      origin_tx_sender: normalizeHex(msg.origin_tx_sender),
      origin_tx_recipient: normalizeHex(msg.origin_tx_recipient),
      is_delivered: msg.is_delivered,
      message_body: normalizeHex(msg.message_body),
    };
  }

  async hasUndeliveredRebalance(
    params: InflightRebalanceQueryParams,
    logger: Logger,
  ): Promise<boolean> {
    const { bridges, routersByDomain, txSender, limit = 5 } = params;

    // Derive routers and domains from routersByDomain
    const routers = Object.values(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    const variables = {
      senders: bridges.map((a) => this.toBytea(a)),
      recipients: bridges.map((a) => this.toBytea(a)),
      originTxRecipients: routers.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      txSenders: [this.toBytea(txSender)],
      limit,
    };

    logger.debug({ variables }, 'Explorer query variables');

    const query = `
      query InflightRebalancesForRoute(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originTxRecipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $txSenders: [bytea!],
        $limit: Int = 25
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_tx_recipient: { _in: $originTxRecipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } },
              { origin_tx_sender: { _in: $txSenders } }
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
          origin_tx_sender
          origin_tx_recipient
          is_delivered
          message_body
        }
      }`;

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    logger.debug({ status: res.status }, 'Explorer query response');

    if (!res.ok) {
      let errorDetails: string;
      try {
        const errorJson = await res.json();
        errorDetails = JSON.stringify(errorJson);
      } catch (_e) {
        try {
          // Fallback to text if JSON parsing fails
          errorDetails = await res.text();
        } catch (_textError) {
          errorDetails = 'Unable to read response body';
        }
      }
      throw new Error(`Explorer query failed: ${res.status} ${errorDetails}`);
    }

    const json = await res.json();
    const rows = json?.data?.message_view ?? [];

    logger.debug({ rows }, 'Explorer query rows');

    // Post-query validation: verify each message's origin domain matches the expected router
    const validatedRows = rows.filter((msg: any) => {
      const expectedRouter = routersByDomain[msg.origin_domain_id];
      if (!expectedRouter) return false;
      const normalizedMsgRouter = msg.origin_tx_recipient?.startsWith('\\x')
        ? '0x' + msg.origin_tx_recipient.slice(2)
        : msg.origin_tx_recipient;
      return (
        normalizedMsgRouter?.toLowerCase() === expectedRouter.toLowerCase()
      );
    });

    logger.debug(
      { totalRows: rows.length, validatedRows: validatedRows.length },
      'Post-query validation results',
    );

    return validatedRows.length > 0;
  }

  /**
   * Query inflight user transfers from the Explorer.
   * Returns transfers where sender/recipient are routers, excluding rebalancer's own transactions.
   */
  async getInflightUserTransfers(
    params: UserTransferQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    const { routersByDomain, excludeTxSender, limit = 100 } = params;

    // Derive routers and domains from routersByDomain
    const routers = Object.values(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    const variables = {
      senders: routers.map((a) => this.toBytea(a)),
      recipients: routers.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      excludeTxSender: this.toBytea(excludeTxSender),
      limit,
    };

    logger.debug({ variables }, 'Explorer getInflightUserTransfers query');

    const query = `
      query InflightUserTransfers(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $excludeTxSender: bytea!,
        $limit: Int = 100
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } },
              { origin_tx_sender: { _neq: $excludeTxSender } }
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
          origin_tx_sender
          is_delivered
          message_body
        }
      }`;

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    logger.debug(
      { status: res.status },
      'Explorer getInflightUserTransfers response',
    );

    if (!res.ok) {
      let errorDetails: string;
      try {
        const errorJson = await res.json();
        errorDetails = JSON.stringify(errorJson);
      } catch (_e) {
        try {
          errorDetails = await res.text();
        } catch (_textError) {
          errorDetails = 'Unable to read response body';
        }
      }
      throw new Error(`Explorer query failed: ${res.status} ${errorDetails}`);
    }

    const json = await res.json();
    const messages = json?.data?.message_view ?? [];
    return messages.map((msg: any) => this.normalizeExplorerMessage(msg));
  }

  /**
   * Query inflight rebalance actions from the Explorer.
   * Returns messages where sender/recipient are bridges, tx sender is the rebalancer,
   * and origin_tx_recipient is one of this warp route's routers.
   */
  async getInflightRebalanceActions(
    params: RebalanceActionQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    const { bridges, routersByDomain, rebalancerAddress, limit = 100 } = params;

    // Derive routers and domains from routersByDomain
    const routers = Object.values(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    const variables = {
      senders: bridges.map((a) => this.toBytea(a)),
      recipients: bridges.map((a) => this.toBytea(a)),
      originTxRecipients: routers.map((a) => this.toBytea(a)),
      originDomains: domains,
      destDomains: domains,
      txSender: this.toBytea(rebalancerAddress),
      limit,
    };

    logger.debug({ variables }, 'Explorer getInflightRebalanceActions query');

    const query = `
      query InflightRebalanceActions(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originTxRecipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $txSender: bytea!,
        $limit: Int = 100
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_tx_recipient: { _in: $originTxRecipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } },
              { origin_tx_sender: { _eq: $txSender } }
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
          origin_tx_sender
          origin_tx_recipient
          is_delivered
          message_body
        }
      }`;

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    logger.debug(
      { status: res.status },
      'Explorer getInflightRebalanceActions response',
    );

    if (!res.ok) {
      let errorDetails: string;
      try {
        const errorJson = await res.json();
        errorDetails = JSON.stringify(errorJson);
      } catch (_e) {
        try {
          errorDetails = await res.text();
        } catch (_textError) {
          errorDetails = 'Unable to read response body';
        }
      }
      throw new Error(`Explorer query failed: ${res.status} ${errorDetails}`);
    }

    const json = await res.json();
    const messages = json?.data?.message_view ?? [];
    return messages.map((msg: any) => this.normalizeExplorerMessage(msg));
  }
}
