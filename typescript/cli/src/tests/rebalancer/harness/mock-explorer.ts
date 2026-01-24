import http from 'http';

import { Address } from '@hyperlane-xyz/utils';

export interface InflightMessage {
  msgId: string;
  originChainId: number;
  originDomainId: number;
  destinationChainId: number;
  destinationDomainId: number;
  sender: Address;
  recipient: Address;
  amount?: bigint;
  status: 'pending' | 'delivered';
}

/**
 * Mock Explorer server for simulating inflight messages.
 *
 * This server mimics the Hyperlane Explorer GraphQL API that the
 * ActionTracker queries to discover pending transfers.
 */
export class MockExplorerServer {
  private server: http.Server;
  private messages: InflightMessage[] = [];
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
   *
   * @param initialMessages Optional initial messages to serve
   * @returns MockExplorerServer instance
   */
  static async create(
    initialMessages?: InflightMessage[],
  ): Promise<MockExplorerServer> {
    const server = new MockExplorerServer();
    if (initialMessages) {
      server.messages = [...initialMessages];
    }

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
   * Add an inflight message.
   */
  addMessage(message: InflightMessage): void {
    this.messages.push(message);
  }

  /**
   * Remove an inflight message by ID.
   */
  removeMessage(msgId: string): void {
    this.messages = this.messages.filter((m) => m.msgId !== msgId);
  }

  /**
   * Set all messages (replaces existing).
   */
  setMessages(messages: InflightMessage[]): void {
    this.messages = [...messages];
  }

  /**
   * Clear all messages.
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Get current messages.
   */
  getMessages(): InflightMessage[] {
    return [...this.messages];
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
   * Handle GraphQL requests.
   * Returns messages in the format expected by ExplorerClient.
   */
  private handleGraphQLRequest(
    _body: string,
    res: http.ServerResponse,
  ): void {
    // Format messages for the Explorer API response
    // The ExplorerClient expects a message_view array
    const messageView = this.messages
      .filter((m) => m.status === 'pending')
      .map((m) => ({
        msg_id: m.msgId,
        origin_chain_id: m.originChainId,
        origin_domain_id: m.originDomainId,
        destination_chain_id: m.destinationChainId,
        destination_domain_id: m.destinationDomainId,
        sender: m.sender,
        recipient: m.recipient,
        // Include amount in the message body if provided
        // This is a simplification - real Explorer API has more complex structure
      }));

    const response = {
      data: {
        message_view: messageView,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }
}

/**
 * Helper to create an inflight message for testing.
 *
 * @param params Message parameters
 * @returns InflightMessage object
 */
export function createInflightMessage(params: {
  msgId?: string;
  originChainId: number;
  originDomainId: number;
  destinationChainId: number;
  destinationDomainId: number;
  sender: Address;
  recipient: Address;
  amount?: bigint;
  status?: 'pending' | 'delivered';
}): InflightMessage {
  return {
    msgId: params.msgId ?? `0x${Math.random().toString(16).slice(2)}`,
    originChainId: params.originChainId,
    originDomainId: params.originDomainId,
    destinationChainId: params.destinationChainId,
    destinationDomainId: params.destinationDomainId,
    sender: params.sender,
    recipient: params.recipient,
    amount: params.amount,
    status: params.status ?? 'pending',
  };
}
