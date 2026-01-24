/**
 * HistoricalTrafficReplay
 *
 * Fetches historical warp route transfer data from the Hyperlane Explorer API
 * and replays it as a TrafficSource for simulation.
 */
import type { ChainMap } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { TrafficSource, Transfer } from './types.js';

// ============================================================================
// Explorer API Types
// ============================================================================

export interface ExplorerMessage {
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
  // Additional fields for historical queries
  origin_block_timestamp?: string;
  send_occurred_at?: string;
}

export interface HistoricalReplayConfig {
  /** Explorer API URL (defaults to https://explorer.hyperlane.xyz/api) */
  explorerApiUrl?: string;

  /** Warp route router addresses by chain name */
  routersByChain: Record<string, Address>;

  /** Domain IDs by chain name */
  domainsByChain: Record<string, number>;

  /** Start time for historical data */
  startTime: Date;

  /** End time for historical data */
  endTime: Date;

  /** Optional: Speed multiplier for replay (e.g., 60 = 1 hour replays in 1 minute) */
  speedMultiplier?: number;

  /** Optional: Limit number of transfers to fetch */
  limit?: number;
}

// ============================================================================
// Token Message Parsing
// ============================================================================

/**
 * Parse transfer amount from a Hyperlane TokenMessage body.
 *
 * TokenMessage format (from @hyperlane-xyz/sdk TokenMessage):
 * - bytes32 recipient (32 bytes)
 * - uint256 amount (32 bytes)
 * - bytes metadata (variable)
 *
 * Total minimum: 64 bytes (128 hex chars + 0x prefix = 130 chars)
 */
export function parseTokenMessageAmount(messageBody: string): bigint | null {
  try {
    // Remove 0x prefix if present
    const body = messageBody.startsWith('0x')
      ? messageBody.slice(2)
      : messageBody;

    // Minimum length: 32 bytes recipient + 32 bytes amount = 64 bytes = 128 hex chars
    if (body.length < 128) {
      return null;
    }

    // Amount is bytes 32-64 (hex chars 64-128)
    const amountHex = body.slice(64, 128);
    return BigInt('0x' + amountHex);
  } catch {
    return null;
  }
}

/**
 * Parse recipient from a Hyperlane TokenMessage body.
 */
export function parseTokenMessageRecipient(messageBody: string): string | null {
  try {
    const body = messageBody.startsWith('0x')
      ? messageBody.slice(2)
      : messageBody;

    if (body.length < 64) {
      return null;
    }

    // Recipient is first 32 bytes, but it's a bytes32 so the address is in the last 20 bytes
    const recipientHex = body.slice(24, 64); // Skip first 12 bytes (24 hex chars)
    return '0x' + recipientHex;
  } catch {
    return null;
  }
}

// ============================================================================
// Explorer Client for Historical Data
// ============================================================================

export class HistoricalExplorerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = 'https://explorer.hyperlane.xyz/api') {
    this.baseUrl = baseUrl;
  }

  private toBytea(addr: string): string {
    return addr.replace(/^0x/i, '\\x').toLowerCase();
  }

  private normalizeHex(hex: string): string {
    if (!hex) return hex;
    return hex.startsWith('\\x') ? '0x' + hex.slice(2) : hex;
  }

  /**
   * Fetch historical warp route transfers within a time range.
   *
   * Note: The Explorer API may have pagination limits. For large time ranges,
   * you may need to fetch in batches.
   */
  async getHistoricalTransfers(params: {
    routerAddresses: string[];
    domainIds: number[];
    startTime: Date;
    endTime: Date;
    limit?: number;
  }): Promise<ExplorerMessage[]> {
    const {
      routerAddresses,
      domainIds,
      startTime,
      endTime,
      limit = 1000,
    } = params;

    // GraphQL query to fetch historical messages
    // We query for delivered messages where sender/recipient are warp routers
    const query = `
      query HistoricalWarpTransfers(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destDomains: [Int!],
        $startTime: timestamp!,
        $endTime: timestamp!,
        $limit: Int = 1000
      ) {
        message_view(
          where: {
            _and: [
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } },
              { send_occurred_at: { _gte: $startTime } },
              { send_occurred_at: { _lte: $endTime } }
            ]
          }
          order_by: { send_occurred_at: asc }
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
          send_occurred_at
        }
      }`;

    const variables = {
      senders: routerAddresses.map((a) => this.toBytea(a)),
      recipients: routerAddresses.map((a) => this.toBytea(a)),
      originDomains: domainIds,
      destDomains: domainIds,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      limit,
    };

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      let errorDetails: string;
      try {
        const errorJson = await res.json();
        errorDetails = JSON.stringify(errorJson);
      } catch {
        try {
          errorDetails = await res.text();
        } catch {
          errorDetails = 'Unable to read response body';
        }
      }
      throw new Error(`Explorer query failed: ${res.status} ${errorDetails}`);
    }

    const json = await res.json();

    // Check for GraphQL errors
    if (json.errors) {
      throw new Error(`Explorer GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    const messages = json?.data?.message_view ?? [];

    return messages.map((msg: any) => ({
      msg_id: this.normalizeHex(msg.msg_id),
      origin_domain_id: msg.origin_domain_id,
      destination_domain_id: msg.destination_domain_id,
      sender: this.normalizeHex(msg.sender),
      recipient: this.normalizeHex(msg.recipient),
      origin_tx_hash: this.normalizeHex(msg.origin_tx_hash),
      origin_tx_sender: this.normalizeHex(msg.origin_tx_sender),
      origin_tx_recipient: this.normalizeHex(msg.origin_tx_recipient),
      is_delivered: msg.is_delivered,
      message_body: this.normalizeHex(msg.message_body),
      send_occurred_at: msg.send_occurred_at,
    }));
  }
}

// ============================================================================
// Historical Traffic Replay
// ============================================================================

/**
 * A TrafficSource that replays historical warp route transfers.
 *
 * Fetches transfer data from the Hyperlane Explorer API and replays
 * it in simulation time.
 */
export class HistoricalTrafficReplay implements TrafficSource {
  private transfers: Transfer[] = [];
  private readonly config: HistoricalReplayConfig;
  private readonly chainByDomain: Record<number, string>;
  private loaded = false;

  constructor(config: HistoricalReplayConfig) {
    this.config = config;

    // Build reverse lookup: domain -> chain name
    this.chainByDomain = {};
    for (const [chain, domain] of Object.entries(config.domainsByChain)) {
      this.chainByDomain[domain] = chain;
    }
  }

  /**
   * Load historical data from the Explorer API.
   * Must be called before using the traffic source.
   */
  async load(): Promise<void> {
    const client = new HistoricalExplorerClient(this.config.explorerApiUrl);

    const routerAddresses = Object.values(this.config.routersByChain);
    const domainIds = Object.values(this.config.domainsByChain);

    const messages = await client.getHistoricalTransfers({
      routerAddresses,
      domainIds,
      startTime: this.config.startTime,
      endTime: this.config.endTime,
      limit: this.config.limit,
    });

    // Convert messages to transfers
    const startTimeMs = this.config.startTime.getTime();

    this.transfers = messages
      .map((msg, index) => {
        const amount = parseTokenMessageAmount(msg.message_body);
        if (amount === null || amount === 0n) {
          return null; // Skip messages we can't parse
        }

        const originChain = this.chainByDomain[msg.origin_domain_id];
        const destChain = this.chainByDomain[msg.destination_domain_id];

        if (!originChain || !destChain) {
          return null; // Skip unknown chains
        }

        // Calculate simulation timestamp (relative to start)
        const msgTime = msg.send_occurred_at
          ? new Date(msg.send_occurred_at).getTime()
          : startTimeMs;
        const relativeTime = msgTime - startTimeMs;

        // Apply speed multiplier
        const simulationTime = this.config.speedMultiplier
          ? relativeTime / this.config.speedMultiplier
          : relativeTime;

        const recipient = parseTokenMessageRecipient(msg.message_body);

        return {
          id: msg.msg_id || `transfer-${index}`,
          timestamp: Math.max(0, simulationTime),
          origin: originChain,
          destination: destChain,
          amount,
          sender: msg.origin_tx_sender as Address,
          recipient: (recipient || msg.origin_tx_sender) as Address,
        };
      })
      .filter((t): t is Transfer => t !== null)
      .sort((a, b) => a.timestamp - b.timestamp);

    this.loaded = true;
  }

  /**
   * Get transfers in a time window.
   */
  getTransfers(startTime: number, endTime: number): Transfer[] {
    if (!this.loaded) {
      throw new Error('Historical traffic not loaded. Call load() first.');
    }

    return this.transfers.filter(
      (t) => t.timestamp >= startTime && t.timestamp < endTime,
    );
  }

  /**
   * Total number of transfers in the source.
   */
  getTotalTransferCount(): number {
    return this.transfers.length;
  }

  /**
   * Time range covered by this source.
   */
  getTimeRange(): { start: number; end: number } {
    if (this.transfers.length === 0) {
      return { start: 0, end: 0 };
    }

    // Calculate duration based on config or actual data
    const configDurationMs =
      this.config.endTime.getTime() - this.config.startTime.getTime();
    const simulationDuration = this.config.speedMultiplier
      ? configDurationMs / this.config.speedMultiplier
      : configDurationMs;

    return {
      start: 0,
      end: simulationDuration,
    };
  }

  /**
   * Get the raw transfer data (for inspection/debugging).
   */
  getRawTransfers(): Transfer[] {
    return [...this.transfers];
  }
}

// ============================================================================
// Static Traffic Source (from pre-loaded data)
// ============================================================================

/**
 * A TrafficSource that uses pre-loaded transfer data.
 * Useful for testing with mock data or cached historical data.
 */
export class StaticTrafficSource implements TrafficSource {
  constructor(private readonly transfers: Transfer[]) {
    // Sort by timestamp
    this.transfers = [...transfers].sort((a, b) => a.timestamp - b.timestamp);
  }

  getTransfers(startTime: number, endTime: number): Transfer[] {
    return this.transfers.filter(
      (t) => t.timestamp >= startTime && t.timestamp < endTime,
    );
  }

  getTotalTransferCount(): number {
    return this.transfers.length;
  }

  getTimeRange(): { start: number; end: number } {
    if (this.transfers.length === 0) {
      return { start: 0, end: 0 };
    }
    return {
      start: this.transfers[0].timestamp,
      end: this.transfers[this.transfers.length - 1].timestamp,
    };
  }
}
