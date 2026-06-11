import { ethers } from 'ethers';
import type { RouteResponse } from '../client/schemas.js';
import {
  BRIDGE_EVENT_TOPIC,
  CROSS_CHAIN_SWAP_TOPIC,
  DEFAULT_EXPLORER_API_URL,
  DEFAULT_POLLING_INTERVAL_MS,
  DISPATCH_ID_TOPIC,
} from '../utils/constants.js';
import { maybeSubmitToRelayApi } from './relay.js';
import { sleep } from '../utils.js';

export enum SwapStatus {
  Pending = 'Pending',
  OriginConfirmed = 'OriginConfirmed',
  Bridging = 'Bridging',
  DestinationConfirmed = 'DestinationConfirmed',
  DestSwapExecuted = 'DestSwapExecuted',
  // ICA dest swap failed; fallback transfer occurred — recipient got bridge asset.
  DestSwapFailed = 'DestSwapFailed',
  Failed = 'Failed',
}

export interface SwapStatusUpdate {
  status: SwapStatus;
  timestamp: number;
  originTxHash?: string;
  msgIds?: string[];
  destinationTxHash?: string;
  error?: string;
}

export interface SwapDeliveryResult {
  status: SwapStatus;
  destinationTxHash?: string;
  msgIds?: string[];
}

export class SwapTracker {
  private _status: SwapStatus = SwapStatus.Pending;
  private _msgIds: string[] = [];
  private _originTxHash?: string;
  private _destinationTxHash?: string;
  private _error?: string;
  private _cancelled = false;

  private _originResolve!: () => void;
  private _originReject!: (err: Error) => void;
  private _deliveredResolve!: (r: SwapDeliveryResult) => void;
  private _deliveredReject!: (err: Error) => void;

  readonly originConfirmed: Promise<void>;
  readonly delivered: Promise<SwapDeliveryResult>;

  constructor(
    private readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL_MS,
    private readonly explorerApiUrl: string = DEFAULT_EXPLORER_API_URL,
    private readonly relayApiUrl?: string,
  ) {
    this.originConfirmed = new Promise((resolve, reject) => {
      this._originResolve = resolve;
      this._originReject = reject;
    });
    this.delivered = new Promise((resolve, reject) => {
      this._deliveredResolve = resolve;
      this._deliveredReject = reject;
    });
  }

  get status(): SwapStatus {
    return this._status;
  }

  cancel(): void {
    this._cancelled = true;
  }

  async *watch(intervalMs?: number): AsyncIterable<SwapStatusUpdate> {
    const interval = intervalMs ?? this.pollingInterval;
    let lastStatus = this._status;
    while (!this._cancelled && this._status !== SwapStatus.Failed) {
      if (this._status !== lastStatus) {
        lastStatus = this._status;
        yield this.currentUpdate();
      }
      if (
        this._status === SwapStatus.DestinationConfirmed ||
        this._status === SwapStatus.DestSwapExecuted ||
        this._status === SwapStatus.DestSwapFailed
      ) {
        break;
      }
      await sleep(interval);
    }
    yield this.currentUpdate();
  }

  // Called by executor once the origin tx is in-flight.
  onOriginTxSent(
    txHash: string,
    provider: ethers.providers.Provider,
    route: RouteResponse,
    srcChainId: number,
    dstChainId: number,
  ): void {
    this._originTxHash = txHash;
    void this.trackOrigin(txHash, provider, route, srcChainId, dstChainId);
  }

  private currentUpdate(): SwapStatusUpdate {
    return {
      status: this._status,
      timestamp: Date.now(),
      originTxHash: this._originTxHash,
      msgIds: this._msgIds.length > 0 ? this._msgIds : undefined,
      destinationTxHash: this._destinationTxHash,
      error: this._error,
    };
  }

  private transition(status: SwapStatus): void {
    this._status = status;
  }

  private async trackOrigin(
    txHash: string,
    provider: ethers.providers.Provider,
    route: RouteResponse,
    srcChainId: number,
    dstChainId: number,
  ): Promise<void> {
    try {
      const receipt = await waitForReceipt(
        provider,
        txHash,
        this.pollingInterval,
      );
      if (receipt.status === 0) {
        this.transition(SwapStatus.Failed);
        this._error = 'Origin transaction reverted';
        this._originReject(new Error(this._error));
        this._deliveredReject(new Error(this._error));
        return;
      }

      // Fire-and-forget CCTP relay submission before resolving origin.
      if (this.relayApiUrl) {
        void maybeSubmitToRelayApi(receipt, srcChainId, this.relayApiUrl);
      }

      this.transition(SwapStatus.OriginConfirmed);
      this._originResolve();

      const isBridgeRoute = route.steps.some((s) => s.type === 'bridge');
      if (!isBridgeRoute) {
        // Same-chain swap; delivered immediately on origin confirm.
        this.transition(SwapStatus.DestinationConfirmed);
        this._deliveredResolve({ status: this._status });
        return;
      }

      // Extract Hyperlane message IDs from Mailbox DispatchId events.
      const msgIds = extractDispatchIds(receipt);
      if (msgIds.length === 0) {
        throw new Error(
          'Origin transaction confirmed but no Hyperlane DispatchId events found — the bridge call may have reverted internally',
        );
      }
      this._msgIds = msgIds;

      this.transition(SwapStatus.Bridging);
      await this.trackHyperlane(msgIds, dstChainId);
    } catch (err) {
      this.transition(SwapStatus.Failed);
      this._error = String(err);
      this._originReject(err instanceof Error ? err : new Error(this._error));
      this._deliveredReject(
        err instanceof Error ? err : new Error(this._error),
      );
    }
  }

  private async trackHyperlane(
    msgIds: string[],
    _dstChainId: number,
  ): Promise<void> {
    const hasDestSwap = msgIds.length >= 2; // commit + reveal = 2 messages
    // Poll all message IDs in parallel; resolve when all are delivered.
    try {
      await Promise.all(msgIds.map((id) => this.pollMessageDelivered(id)));
      this.transition(
        hasDestSwap
          ? SwapStatus.DestSwapExecuted
          : SwapStatus.DestinationConfirmed,
      );
      this._deliveredResolve({
        status: this._status,
        msgIds,
        destinationTxHash: this._destinationTxHash,
      });
    } catch (err) {
      this.transition(SwapStatus.Failed);
      this._error = String(err);
      this._deliveredReject(
        err instanceof Error ? err : new Error(this._error),
      );
    }
  }

  private async pollMessageDelivered(msgId: string): Promise<void> {
    // Explorer uses Hasura GraphQL. msg_id must be encoded as PostgreSQL bytea: \\x<hex_without_0x>
    const byteaMsgId = `\\x${msgId.replace(/^0x/i, '').toLowerCase()}`;
    const query = `query($msgId: bytea!) {
      message_view(where: {msg_id: {_eq: $msgId}}, limit: 1) {
        is_delivered
        destination_tx_hash
      }
    }`;

    while (!this._cancelled) {
      try {
        const res = await fetch(this.explorerApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { msgId: byteaMsgId } }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: {
              message_view?: Array<{
                is_delivered: boolean;
                destination_tx_hash?: string | null;
              }>;
            };
          };
          const msg = json.data?.message_view?.[0];
          if (msg?.is_delivered) {
            if (msg.destination_tx_hash) {
              // Convert bytea \\xhex → 0xhex
              this._destinationTxHash =
                '0x' + msg.destination_tx_hash.replace(/^\\x/, '');
            }
            return;
          }
        }
      } catch {
        // Transient fetch error — keep polling.
      }
      await sleep(this.pollingInterval);
    }
  }
}

async function waitForReceipt(
  provider: ethers.providers.Provider,
  txHash: string,
  intervalMs: number,
): Promise<ethers.providers.TransactionReceipt> {
  while (true) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.confirmations >= 1) return receipt;
    await sleep(intervalMs);
  }
}

// Returns true when the receipt contains at least one UniversalRouter bridge event,
// confirming the tx actually triggered a cross-chain transfer.
export function receiptHasBridgeEvent(
  receipt: ethers.providers.TransactionReceipt,
): boolean {
  return receipt.logs.some(
    (log) =>
      log.topics[0] === BRIDGE_EVENT_TOPIC ||
      log.topics[0] === CROSS_CHAIN_SWAP_TOPIC,
  );
}

// Extracts Hyperlane message IDs from Mailbox DispatchId(bytes32) events.
// topics[0] = DispatchId event selector
// topics[1] = bytes32 messageId (the identifier the explorer and relayer use)
//
// A simple bridge emits 1 DispatchId. A bridge+dest-swap route emits 2
// (one for the warp transfer, one for the ICA commit message).
function extractDispatchIds(
  receipt: ethers.providers.TransactionReceipt,
): string[] {
  return receipt.logs
    .filter((log) => log.topics[0] === DISPATCH_ID_TOPIC && log.topics[1])
    .map((log) => log.topics[1]);
}

export interface MessageDeliveryStatus {
  isDelivered: boolean;
  destinationTxHash?: string;
}

// Single-shot delivery check — does not poll. Returns the current state.
// Useful for agents that want to check status on their own schedule.
export async function checkMessageDelivery(
  msgId: string,
  explorerApiUrl = DEFAULT_EXPLORER_API_URL,
): Promise<MessageDeliveryStatus> {
  const byteaMsgId = `\\x${msgId.replace(/^0x/i, '').toLowerCase()}`;
  const query = `query($msgId: bytea!) {
    message_view(where: {msg_id: {_eq: $msgId}}, limit: 1) {
      is_delivered
      destination_tx_hash
    }
  }`;
  const res = await fetch(explorerApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { msgId: byteaMsgId } }),
  });
  if (!res.ok) throw new Error(`Explorer query failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: {
      message_view?: Array<{
        is_delivered: boolean;
        destination_tx_hash?: string | null;
      }>;
    };
  };
  const msg = json.data?.message_view?.[0];
  if (!msg) return { isDelivered: false };
  return {
    isDelivered: msg.is_delivered,
    destinationTxHash: msg.destination_tx_hash
      ? '0x' + msg.destination_tx_hash.replace(/^\\x/, '')
      : undefined,
  };
}
