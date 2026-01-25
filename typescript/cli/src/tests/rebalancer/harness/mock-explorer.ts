import http from 'http';

import type { Address } from '@hyperlane-xyz/utils';

/**
 * Message structure matching the ExplorerClient's ExplorerMessage type.
 * All hex values should be stored in 0x format internally.
 */
export interface MockMessage {
  msgId: string;
  originDomainId: number;
  destinationDomainId: number;
  sender: Address;
  recipient: Address;
  originTxHash: string;
  originTxSender: Address;
  originTxRecipient?: Address;
  messageBody: string;
  isDelivered: boolean;
}

/**
 * Mock Explorer server for simulating inflight messages.
 *
 * This server mimics the Hyperlane Explorer GraphQL API that the
 * ActionTracker queries to discover pending transfers and rebalance actions.
 *
 * It supports the following queries:
 * - InflightUserTransfers: Get pending user transfers (excludes rebalancer's txs)
 * - InflightRebalanceActions: Get pending rebalance actions (only rebalancer's txs)
 * - InflightRebalancesForRoute: Check if there are any pending rebalances
 */
export class MockExplorerServer {
  private server: http.Server;
  private messages: MockMessage[] = [];
  private port: number = 0;

  private constructor() {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          this.handleGraphQLRequest(body, res);
        });
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  }

  /**
   * Create and start a mock explorer server.
   */
  static async create(): Promise<MockExplorerServer> {
    const server = new MockExplorerServer();

    // Start server on random port
    await new Promise<void>((resolve) => {
      server.server.listen(0, () => {
        const address = server.server.address();
        if (typeof address === 'object' && address !== null) {
          server.port = address.port;
        }
        resolve();
      });
    });

    return server;
  }

  /**
   * Get the URL of the mock explorer server.
   */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Add an inflight message from a warp transfer.
   * This should be called when a Dispatch event is detected.
   */
  addMessage(message: MockMessage): void {
    this.messages.push(message);
  }

  /**
   * Mark a message as delivered by its message ID.
   * This should be called when the message is processed on the destination.
   */
  markDelivered(msgId: string): void {
    const message = this.messages.find((m) => m.msgId === msgId);
    if (message) {
      message.isDelivered = true;
    }
  }

  /**
   * Remove a message by ID.
   */
  removeMessage(msgId: string): void {
    this.messages = this.messages.filter((m) => m.msgId !== msgId);
  }

  /**
   * Clear all messages.
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Get current messages (returns a copy).
   */
  getMessages(): MockMessage[] {
    return [...this.messages];
  }

  /**
   * Get pending (undelivered) messages.
   */
  getPendingMessages(): MockMessage[] {
    return this.messages.filter((m) => !m.isDelivered);
  }

  /**
   * Close the server.
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /**
   * Convert address to PostgreSQL bytea format for comparison.
   */
  private toBytea(addr: string): string {
    return addr.replace(/^0x/i, '\\x').toLowerCase();
  }

  /**
   * Check if two addresses match (handles both 0x and \\x formats).
   */
  private addressMatch(addr1: string, addr2: string): boolean {
    const normalize = (a: string) => a.replace(/^(0x|\\x)/i, '').toLowerCase();
    return normalize(addr1) === normalize(addr2);
  }

  /**
   * Check if an address is in a list (handles both formats).
   */
  private addressInList(addr: string, list: string[]): boolean {
    return list.some((item) => this.addressMatch(addr, item));
  }

  /**
   * Handle GraphQL requests from ExplorerClient.
   */
  private handleGraphQLRequest(body: string, res: http.ServerResponse): void {
    try {
      const { query, variables } = JSON.parse(body);

      // Determine query type and filter messages accordingly
      let filteredMessages: MockMessage[] = [];

      if (query.includes('InflightUserTransfers')) {
        filteredMessages = this.handleUserTransfersQuery(variables);
      } else if (query.includes('InflightRebalanceActions')) {
        filteredMessages = this.handleRebalanceActionsQuery(variables);
      } else if (query.includes('InflightRebalancesForRoute')) {
        filteredMessages = this.handleInflightRebalancesQuery(variables);
      } else {
        // Default: return all pending messages
        filteredMessages = this.messages.filter((m) => !m.isDelivered);
      }

      // Format response in Explorer API format
      const messageView = filteredMessages.map((m) => ({
        msg_id: this.toBytea(m.msgId),
        origin_domain_id: m.originDomainId,
        destination_domain_id: m.destinationDomainId,
        sender: this.toBytea(m.sender),
        recipient: this.toBytea(m.recipient),
        origin_tx_hash: this.toBytea(m.originTxHash),
        origin_tx_sender: this.toBytea(m.originTxSender),
        origin_tx_recipient: m.originTxRecipient
          ? this.toBytea(m.originTxRecipient)
          : undefined,
        is_delivered: m.isDelivered,
        message_body: this.toBytea(m.messageBody),
      }));

      const response = {
        data: {
          message_view: messageView,
        },
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          errors: [{ message: `Mock explorer error: ${error}` }],
        }),
      );
    }
  }

  /**
   * Handle InflightUserTransfers query.
   * Returns pending user transfers, excluding the rebalancer's own transactions.
   *
   * Filters:
   * - is_delivered: false
   * - sender in senders (routers)
   * - recipient in recipients (routers)
   * - origin_domain_id in originDomains
   * - destination_domain_id in destDomains
   * - origin_tx_sender != excludeTxSender (rebalancer address)
   */
  private handleUserTransfersQuery(variables: any): MockMessage[] {
    const {
      senders = [],
      recipients = [],
      originDomains = [],
      destDomains = [],
      excludeTxSender,
      limit = 100,
    } = variables;

    return this.messages
      .filter((m) => {
        // Must be pending
        if (m.isDelivered) return false;

        // Sender must be a router
        if (senders.length > 0 && !this.addressInList(m.sender, senders)) {
          return false;
        }

        // Recipient must be a router
        if (
          recipients.length > 0 &&
          !this.addressInList(m.recipient, recipients)
        ) {
          return false;
        }

        // Origin domain must match
        if (originDomains.length > 0 && !originDomains.includes(m.originDomainId)) {
          return false;
        }

        // Destination domain must match
        if (destDomains.length > 0 && !destDomains.includes(m.destinationDomainId)) {
          return false;
        }

        // Exclude rebalancer's own transactions
        if (excludeTxSender && this.addressMatch(m.originTxSender, excludeTxSender)) {
          return false;
        }

        return true;
      })
      .slice(0, limit);
  }

  /**
   * Handle InflightRebalanceActions query.
   * Returns pending rebalance actions (only the rebalancer's transactions through bridges).
   *
   * Filters:
   * - is_delivered: false
   * - sender in senders (bridges)
   * - recipient in recipients (bridges)
   * - origin_domain_id in originDomains
   * - destination_domain_id in destDomains
   * - origin_tx_sender == txSender (rebalancer address)
   */
  private handleRebalanceActionsQuery(variables: any): MockMessage[] {
    const {
      senders = [],
      recipients = [],
      originDomains = [],
      destDomains = [],
      txSender,
      limit = 100,
    } = variables;

    return this.messages
      .filter((m) => {
        // Must be pending
        if (m.isDelivered) return false;

        // Sender must be a bridge
        if (senders.length > 0 && !this.addressInList(m.sender, senders)) {
          return false;
        }

        // Recipient must be a bridge
        if (
          recipients.length > 0 &&
          !this.addressInList(m.recipient, recipients)
        ) {
          return false;
        }

        // Origin domain must match
        if (originDomains.length > 0 && !originDomains.includes(m.originDomainId)) {
          return false;
        }

        // Destination domain must match
        if (destDomains.length > 0 && !destDomains.includes(m.destinationDomainId)) {
          return false;
        }

        // Must be rebalancer's transaction
        if (txSender && !this.addressMatch(m.originTxSender, txSender)) {
          return false;
        }

        return true;
      })
      .slice(0, limit);
  }

  /**
   * Handle InflightRebalancesForRoute query (hasUndeliveredRebalance).
   * Same as RebalanceActions but also checks originTxRecipient.
   */
  private handleInflightRebalancesQuery(variables: any): MockMessage[] {
    const {
      senders = [],
      recipients = [],
      originTxRecipients = [],
      originDomains = [],
      destDomains = [],
      txSenders = [],
      limit = 25,
    } = variables;

    return this.messages
      .filter((m) => {
        // Must be pending
        if (m.isDelivered) return false;

        // Sender must be a bridge
        if (senders.length > 0 && !this.addressInList(m.sender, senders)) {
          return false;
        }

        // Recipient must be a bridge
        if (
          recipients.length > 0 &&
          !this.addressInList(m.recipient, recipients)
        ) {
          return false;
        }

        // originTxRecipient must be a router
        if (
          originTxRecipients.length > 0 &&
          m.originTxRecipient &&
          !this.addressInList(m.originTxRecipient, originTxRecipients)
        ) {
          return false;
        }

        // Origin domain must match
        if (originDomains.length > 0 && !originDomains.includes(m.originDomainId)) {
          return false;
        }

        // Destination domain must match
        if (destDomains.length > 0 && !destDomains.includes(m.destinationDomainId)) {
          return false;
        }

        // Must be from one of the txSenders (rebalancer)
        if (
          txSenders.length > 0 &&
          !this.addressInList(m.originTxSender, txSenders)
        ) {
          return false;
        }

        return true;
      })
      .slice(0, limit);
  }
}

/**
 * Helper to create a MockMessage from a Dispatch event.
 */
export function createMockMessageFromDispatch(params: {
  messageId: string;
  originDomainId: number;
  destinationDomainId: number;
  sender: Address; // The warp route (router) address that sent
  recipient: Address; // The destination warp route (router) address
  originTxHash: string;
  originTxSender: Address; // The user/rebalancer who initiated the transfer
  originTxRecipient?: Address; // The contract that received the tx (router)
  messageBody: string; // Encoded warp route message with amount
}): MockMessage {
  return {
    msgId: params.messageId,
    originDomainId: params.originDomainId,
    destinationDomainId: params.destinationDomainId,
    sender: params.sender,
    recipient: params.recipient,
    originTxHash: params.originTxHash,
    originTxSender: params.originTxSender,
    originTxRecipient: params.originTxRecipient,
    messageBody: params.messageBody,
    isDelivered: false,
  };
}
