import type { Logger } from 'pino';

export type { Logger };

export interface MetaswapsSDKConfig {
  // Base URL of the Universal Router Engine REST API.
  // Default: 'https://router.services.hyperlane.xyz'
  routingUrl?: string;

  // Call Commitment Service URL for ICA dest-swap routes.
  // Default: 'https://offchain-lookup.services.hyperlane.xyz/callCommitments'
  ccsUrl?: string;

  // Hyperlane Explorer API base URL used for message status polling.
  // Default: 'https://explorer.hyperlane.xyz/api'
  explorerApiUrl?: string;

  // Status polling interval in milliseconds.
  // Default: 5000
  pollingInterval?: number;

  // Override public RPC URLs for specific chains (keyed by EVM chain ID).
  // Falls back to the bundled defaults for unsupplied chains.
  chainRpcUrls?: Record<number, string>;

  // Relay API base URL for fast CCTP processing.
  // Default: 'https://relay-api.hyperlane.xyz'
  // Origin transactions containing CCTP MessageSent events are submitted to
  // {relayApiUrl}/relay immediately after origin confirmation.
  relayApiUrl?: string;

  logger?: Logger;

  // How many seconds in the future to set the UniversalRouter deadline.
  // Default: 300 (5 minutes)
  deadlineSeconds?: number;
}

export interface SwapHandle {
  id: string;
  originTxHash: string;
  status: import('./swap/tracker.js').SwapStatus;

  // Resolves when the origin transaction is confirmed on-chain.
  originConfirmed: Promise<void>;

  // Resolves when the swap reaches a terminal delivered state.
  delivered: Promise<import('./swap/tracker.js').SwapDeliveryResult>;

  // Async iterator that emits a SwapStatusUpdate each time the status changes.
  watch(
    intervalMs?: number,
  ): AsyncIterable<import('./swap/tracker.js').SwapStatusUpdate>;

  // Stop background polling (safe to call multiple times).
  cancel(): void;
}
