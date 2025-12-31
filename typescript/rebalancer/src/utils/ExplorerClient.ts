import type { Logger } from 'pino';

export type InflightRebalanceQueryParams = {
  bridges: string[];
  domains: number[];
  txSender: string;
  limit?: number;
};

export type UserTransferQueryParams = {
  routers: string[]; // Warp route router addresses
  domains: number[]; // Domain IDs
  excludeTxSender: string; // Rebalancer address to exclude
  limit?: number;
};

export type RebalanceActionQueryParams = {
  routers: string[]; // Warp route router addresses
  domains: number[]; // Domain IDs
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
  is_delivered: boolean;
};

export class ExplorerClient {
  constructor(private readonly baseUrl: string) {}

  private toBytea(addr: string): string {
    return addr.replace(/^0x/i, '\\x').toLowerCase();
  }

  async hasUndeliveredRebalance(
    params: InflightRebalanceQueryParams,
    logger: Logger,
  ): Promise<boolean> {
    const { bridges, domains, txSender, limit = 5 } = params;

    const variables = {
      senders: bridges.map((a) => this.toBytea(a)),
      recipients: bridges.map((a) => this.toBytea(a)),
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
          is_delivered
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

    return rows.length > 0;
  }

  /**
   * Query inflight user transfers from the Explorer.
   * Returns transfers where sender/recipient are routers, excluding rebalancer's own transactions.
   */
  async getInflightUserTransfers(
    params: UserTransferQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    const { routers, domains, excludeTxSender, limit = 100 } = params;

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
    return json?.data?.message_view ?? [];
  }

  /**
   * Query inflight rebalance actions from the Explorer.
   * Returns messages where sender/recipient are routers and tx sender is the rebalancer.
   */
  async getInflightRebalanceActions(
    params: RebalanceActionQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    const { routers, domains, rebalancerAddress, limit = 100 } = params;

    const variables = {
      senders: routers.map((a) => this.toBytea(a)),
      recipients: routers.map((a) => this.toBytea(a)),
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
          is_delivered
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
    return json?.data?.message_view ?? [];
  }
}
