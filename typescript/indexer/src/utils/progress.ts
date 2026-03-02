/**
 * Progress tracking for indexer backfill.
 * Logs periodic updates during historical sync.
 */
import { pruneBlockHashCache } from '../db/reorg.js';

import { getLogger } from './logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ViemClient = any;

interface ChainProgress {
  chainName: string;
  startBlock: number;
  latestBlock: number;
  currentBlock: number;
  eventCount: number;
  startTime: number;
  lastLogTime: number;
  lastLatestBlockFetch: number;
}

const chainProgress = new Map<number, ChainProgress>();
const LOG_INTERVAL_MS = 30_000; // Log every 30 seconds
const EVENT_LOG_INTERVAL = 500; // Or every 500 events
const LATEST_BLOCK_REFRESH_MS = 60_000; // Refresh latest block every 60 seconds

/**
 * Initialize progress tracking for a chain.
 */
function initChainProgress(
  chainId: number,
  chainName: string,
  startBlock: number,
): void {
  if (!chainProgress.has(chainId)) {
    chainProgress.set(chainId, {
      chainName,
      startBlock,
      latestBlock: 0,
      currentBlock: startBlock,
      eventCount: 0,
      startTime: Date.now(),
      lastLogTime: Date.now(),
      lastLatestBlockFetch: 0,
    });
    getLogger().info({ chain: chainName, startBlock }, 'Starting indexer');
  }
}

/**
 * Update progress and log if needed.
 * Pass the viem client to enable latest block fetching for ETA calculation.
 */
export async function updateProgress(
  chainId: number,
  chainName: string,
  blockNumber: number,
  client?: ViemClient,
): Promise<void> {
  let progress = chainProgress.get(chainId);

  if (!progress) {
    // Auto-initialize if not done
    initChainProgress(chainId, chainName, blockNumber);
    progress = chainProgress.get(chainId)!;
  }

  progress.currentBlock = blockNumber;
  progress.eventCount++;

  const now = Date.now();

  // Fetch latest block periodically for ETA calculation
  if (
    client &&
    now - progress.lastLatestBlockFetch >= LATEST_BLOCK_REFRESH_MS
  ) {
    try {
      // Ponder's client uses getBlock() instead of getBlockNumber()
      const block = await client.getBlock({ blockTag: 'latest' });
      if (block?.number) {
        progress.latestBlock = Number(block.number);
        progress.lastLatestBlockFetch = now;
      }
    } catch (err) {
      // Log once per chain if fetching fails
      if (progress.latestBlock === 0) {
        getLogger().warn(
          { chain: chainName, err },
          'Could not fetch latest block for ETA',
        );
        progress.lastLatestBlockFetch = now; // Don't spam retries
      }
    }
  }

  const shouldLog =
    now - progress.lastLogTime >= LOG_INTERVAL_MS ||
    progress.eventCount % EVENT_LOG_INTERVAL === 0;

  if (shouldLog) {
    logProgress(progress);
    progress.lastLogTime = now;

    // Prune old block hash cache entries to prevent memory growth
    // Keep last 256 blocks (covers ~2 epochs for finality)
    pruneBlockHashCache(chainId, blockNumber);
  }
}

/**
 * Log current progress for a chain.
 */
function logProgress(progress: ChainProgress): void {
  const elapsed = (Date.now() - progress.startTime) / 1000;
  const blocksProcessed = progress.currentBlock - progress.startBlock;
  const blocksPerSecond = blocksProcessed / elapsed;
  const eventsPerSecond = progress.eventCount / elapsed;

  const logData: Record<string, unknown> = {
    chain: progress.chainName,
    block: progress.currentBlock,
    events: progress.eventCount,
    eventsPerSec: Number(eventsPerSecond.toFixed(1)),
  };

  let status = 'indexing';

  if (progress.latestBlock > 0) {
    const remaining = progress.latestBlock - progress.currentBlock;
    const percentComplete =
      ((progress.currentBlock - progress.startBlock) /
        (progress.latestBlock - progress.startBlock)) *
      100;

    logData.latestBlock = progress.latestBlock;
    logData.percentComplete = Number(percentComplete.toFixed(1));

    if (remaining > 0 && blocksPerSecond > 0) {
      const etaSeconds = remaining / blocksPerSecond;
      logData.etaRemaining = formatEta(etaSeconds);
    } else if (remaining <= 0) {
      status = 'synced';
    }
  }

  getLogger().info(logData, `Indexer progress: ${status}`);
}

/**
 * Format ETA in human-readable form.
 */
function formatEta(seconds: number): string {
  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  } else if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.ceil((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
