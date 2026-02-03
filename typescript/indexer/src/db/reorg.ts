import { getAdapter } from './adapter.js';

/**
 * Reorg detection and history management.
 *
 * Ponder automatically handles reorgs by re-running indexing functions.
 * This module provides utilities to:
 * 1. Detect when a reorg has occurred (block hash changed for same height)
 * 2. Record reorg history for auditing
 * 3. Clean up orphaned data before re-indexing
 */

// Track last seen block hashes per chain/height for reorg detection
const blockHashCache = new Map<string, `0x${string}`>();

function cacheKey(chainId: number, blockHeight: number): string {
  return `${chainId}-${blockHeight}`;
}

/**
 * Check if a block represents a reorg (different hash for same height).
 * If reorg detected, records it and cleans up orphaned data.
 *
 * @returns true if reorg was detected and handled
 */
export async function checkAndHandleReorg(
  chainId: number,
  blockHeight: number,
  newBlockHash: `0x${string}`,
): Promise<boolean> {
  const key = cacheKey(chainId, blockHeight);
  const previousHash = blockHashCache.get(key);

  // Update cache
  blockHashCache.set(key, newBlockHash);

  // No previous hash = first time seeing this block, no reorg
  if (!previousHash) {
    return false;
  }

  // Same hash = no reorg
  if (previousHash === newBlockHash) {
    return false;
  }

  // Different hash = REORG DETECTED
  console.warn(
    `REORG DETECTED on chain ${chainId} at height ${blockHeight}:`,
    `old=${previousHash} new=${newBlockHash}`,
  );

  const adapter = getAdapter();

  // Get affected messages before cleanup
  const affectedMsgIds = await adapter.getMessagesAtBlock(chainId, blockHeight);

  // Record the reorg event
  await adapter.recordReorg(
    chainId,
    blockHeight,
    previousHash,
    newBlockHash,
    affectedMsgIds,
  );

  // Delete orphaned block data (cascades to tx, messages, etc.)
  await adapter.deleteBlockByHash(previousHash);

  console.log(
    `Cleaned up reorged block ${previousHash}, affected ${affectedMsgIds.length} messages`,
  );

  return true;
}

/**
 * Prune old block hash cache entries to prevent memory growth.
 * Called periodically to remove entries for blocks that are now finalized.
 *
 * @param chainId Chain to prune
 * @param currentHeight Current block height
 * @param safetyMargin Number of blocks to keep in cache (default: 256 for ~2 epochs)
 */
export function pruneBlockHashCache(
  chainId: number,
  currentHeight: number,
  safetyMargin = 256,
): number {
  const minHeight = currentHeight - safetyMargin;
  let pruned = 0;

  for (const key of blockHashCache.keys()) {
    const [cid, height] = key.split('-').map(Number);
    if (cid === chainId && height < minHeight) {
      blockHashCache.delete(key);
      pruned++;
    }
  }

  return pruned;
}
