import { Logger } from 'pino';

import { ChainName } from '../types.js';

const DEFAULT_MAX_BATCH_SIZE = 64;

const CHAIN_BATCH_SIZE_OVERRIDES: Partial<Record<ChainName, number>> = {
  citrea: 16,
};

export function getTxConfigBatchSize(chain: ChainName): number {
  return CHAIN_BATCH_SIZE_OVERRIDES[chain] ?? DEFAULT_MAX_BATCH_SIZE;
}

/**
 * Submits `items` to `fn` in sequential batches sized per `chain`.
 *
 * NOTE: Non-atomic. If batch N succeeds and batch N+1 fails, on-chain state
 * is partially mutated and a naive retry will re-submit the already-applied
 * batches. Callers must either (a) pre-filter `items` by comparing against
 * on-chain state before each run (the IGP/oracle path) or (b) accept that a
 * retry may redundantly re-submit already-applied entries (the hook routing
 * path).
 */
export async function submitBatched<T>(
  chain: ChainName,
  items: T[],
  fn: (batch: T[]) => Promise<void>,
  logger: Logger,
  label: string,
): Promise<void> {
  const batchSize = getTxConfigBatchSize(chain);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  logger.info(
    `Splitting ${items.length} ${label} into ${batches.length} transaction(s)`,
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info(
      `Sending batch ${i + 1}/${batches.length} with ${batch.length} config(s)`,
    );
    await fn(batch);
  }
}
