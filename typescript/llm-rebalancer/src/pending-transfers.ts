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
}

export interface PendingTransferProvider {
  getPendingTransfers(): Promise<PendingTransfer[]>;
}
