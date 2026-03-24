import type { Logger } from 'pino';

import { addressToByteHexString, ProtocolType } from '@hyperlane-xyz/utils';

// isEVMLike is not yet exported from the installed dist of @hyperlane-xyz/utils;
// inline the equivalent check until utils dist is rebuilt.
function isEVMLike(protocol: ProtocolType): boolean {
  return protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron;
}

export type InflightRebalanceQueryParams = {
  bridges: string[];
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  txSender: string;
  limit?: number;
};

export type UserTransferQueryParams = {
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  excludeTxSenders: string[]; // Addresses to exclude (rebalancer + inventory signer)
  limit?: number;
};

export type RebalanceActionQueryParams = {
  bridges: string[]; // Bridge contract addresses
  routersByDomain: Record<number, string>; // Domain ID → router address (derive routers and domains from this)
  rebalancerAddress: string; // Include rebalancer's txs
  inventorySignerAddresses?: string[]; // Optional: also include inventory signers' txs (for inventory_deposit actions)
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
  send_occurred_at: string | null;
};

export interface IExplorerClient {
  getInflightUserTransfers(
    params: UserTransferQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]>;
  getInflightRebalanceActions(
    params: RebalanceActionQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]>;
}

export class ExplorerClient implements IExplorerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getProtocol: (domainId: number) => ProtocolType,
  ) {}

  /**
   * Convert an address to PostgreSQL bytea format (\\x-prefixed hex).
   * When `domain` is provided, resolves the chain's protocol to encode
   * non-EVM addresses (e.g. base58 Solana, 32-byte Starknet) correctly
   * via `addressToByteHexString`. Without `domain`, assumes the address
   * is already EVM-format hex (used for bridges, txSender, etc. which
   * are always EVM addresses).
   */
  private toBytea(addr: string, domain?: number): string {
    const protocol =
      domain !== undefined ? this.getProtocol(domain) : undefined;
    if (protocol && !isEVMLike(protocol)) {
      const hex = addressToByteHexString(addr, protocol);
      return hex.replace(/^0x/i, '\\x').toLowerCase();
    }
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
      send_occurred_at: msg.send_occurred_at ?? null,
    };
  }

  async hasUndeliveredRebalance(
    params: InflightRebalanceQueryParams,
    logger: Logger,
  ): Promise<boolean> {
    const { bridges, routersByDomain, txSender, limit = 5 } = params;

    // Derive routers and domains from routersByDomain
    const routerEntries = Object.entries(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    const variables = {
      // NOTE: bridges are always EVM addresses; pass domain here if non-EVM bridges are added
      senders: bridges.map((a) => this.toBytea(a)),
      // NOTE: bridges are always EVM addresses; pass domain here if non-EVM bridges are added
      recipients: bridges.map((a) => this.toBytea(a)),
      originTxRecipients: routerEntries.map(([domain, addr]) =>
        this.toBytea(addr, Number(domain)),
      ),
      originDomains: domains,
      destDomains: domains,
      // NOTE: txSender is always an EVM address (rebalancer signer)
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
      const protocol = this.getProtocol(msg.origin_domain_id);
      const normalizedMsgRouter = msg.origin_tx_recipient?.startsWith('\\x')
        ? '0x' + msg.origin_tx_recipient.slice(2)
        : msg.origin_tx_recipient;
      if (protocol && !isEVMLike(protocol)) {
        const expectedHex = addressToByteHexString(
          expectedRouter,
          protocol,
        ).toLowerCase();
        return normalizedMsgRouter?.toLowerCase() === expectedHex;
      }
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
    const { routersByDomain, excludeTxSenders, limit = 100 } = params;

    // Derive routers and domains from routersByDomain
    const routerEntries = Object.entries(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    const variables = {
      senders: routerEntries.map(([domain, addr]) =>
        this.toBytea(addr, Number(domain)),
      ),
      recipients: routerEntries.map(([domain, addr]) =>
        this.toBytea(addr, Number(domain)),
      ),
      originDomains: domains,
      destDomains: domains,
      // NOTE: excludeTxSenders are always EVM addresses
      excludeTxSenders: excludeTxSenders.map((a) => this.toBytea(a)),
      limit,
    };

    logger.debug({ variables }, 'Explorer getInflightUserTransfers query');

    const query = `
      query InflightUserTransfers(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $excludeTxSenders: [bytea!],
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
              { origin_tx_sender: { _nin: $excludeTxSenders } }
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
          send_occurred_at
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
    const {
      bridges,
      routersByDomain,
      rebalancerAddress,
      inventorySignerAddresses,
      limit = 100,
    } = params;

    // Derive routers and domains from routersByDomain
    const routerEntries = Object.entries(routersByDomain);
    const domains = Object.keys(routersByDomain).map(Number);

    // Build list of tx senders to include (rebalancer + optional inventory signer)
    // NOTE: rebalancerAddress is always an EVM address (rebalancer signer)
    const txSenders = [this.toBytea(rebalancerAddress)];
    if (inventorySignerAddresses) {
      for (const addr of inventorySignerAddresses) {
        // NOTE: inventorySignerAddresses are filtered to ProtocolType.Ethereum
        txSenders.push(this.toBytea(addr));
      }
    }

    const variables = {
      // NOTE: bridges are always EVM addresses; pass domain here if non-EVM bridges are added
      senders: bridges.map((a) => this.toBytea(a)),
      // NOTE: bridges are always EVM addresses; pass domain here if non-EVM bridges are added
      recipients: bridges.map((a) => this.toBytea(a)),
      originTxRecipients: routerEntries.map(([domain, addr]) =>
        this.toBytea(addr, Number(domain)),
      ),
      originDomains: domains,
      destDomains: domains,
      txSenders,
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
        $txSenders: [bytea!],
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
          send_occurred_at
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
