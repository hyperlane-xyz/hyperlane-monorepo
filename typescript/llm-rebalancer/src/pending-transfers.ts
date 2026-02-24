/**
 * PendingTransferProvider interface — abstracts inflight user transfer queries.
 *
 * Two implementations:
 * - ExplorerPendingTransferProvider (production): queries Hyperlane Explorer API
 * - MockActionTracker adapter (simulation): wraps tracker.getInProgressTransfers()
 */

export interface PendingTransfer {
  messageId: string;
  origin: string;
  destination: string;
  /** Amount in wei */
  amount: string;
  /** Source asset symbol (e.g., USDC) — present in multi-asset deployments */
  sourceAsset?: string;
  /** Destination asset symbol (e.g., USDT) — present in cross-asset transfers */
  destinationAsset?: string;
  /** Destination warp token address — present in cross-asset transfers */
  targetRouter?: string;
}

export interface PendingTransferProvider {
  getPendingTransfers(): Promise<PendingTransfer[]>;
}
