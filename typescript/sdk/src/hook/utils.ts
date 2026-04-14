import { Logger } from 'pino';

import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { ChainName } from '../types.js';

import { AggregationHookConfig, DerivedHookConfig, HookType } from './types.js';

const DEFAULT_MAX_BATCH_SIZE = 64;

const CHAIN_BATCH_SIZE_OVERRIDES: Partial<Record<ChainName, number>> = {
  citrea: 16,
};

export function getHookTxBatchSize(chain: ChainName): number {
  return CHAIN_BATCH_SIZE_OVERRIDES[chain] ?? DEFAULT_MAX_BATCH_SIZE;
}

export async function submitBatched<T>(
  chain: ChainName,
  items: T[],
  fn: (batch: T[]) => Promise<void>,
  logger: Logger,
  label: string,
): Promise<void> {
  const batchSize = getHookTxBatchSize(chain);
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

/**
 * Checks if the given hook type is compatible with the chain's technical stack.
 *
 * @param {HookType} params.hookType - The type of hook
 * @param {ChainTechnicalStack | undefined} params.chainTechnicalStack - The technical stack of the chain
 * @returns {boolean} True if the hook type is compatible with the chain, false otherwise
 */
/**
 * Strips the PREDICATE sub-hook from an aggregation hook config.
 * If the aggregation contains exactly one non-predicate hook, unwraps it.
 * Returns the hook unchanged if no predicate is found or multiple remain.
 */
export function stripPredicateSubHook(
  hook: DerivedHookConfig | string,
): DerivedHookConfig | string {
  if (typeof hook === 'string' || hook.type !== HookType.AGGREGATION)
    return hook;

  const agg = hook as AggregationHookConfig;
  const remaining = agg.hooks.filter(
    (h) =>
      typeof h === 'string' ||
      (h as DerivedHookConfig).type !== HookType.PREDICATE,
  );

  if (remaining.length === agg.hooks.length) return hook; // no predicate found
  if (remaining.length === 1) return remaining[0] as DerivedHookConfig | string;
  // Multiple non-predicate hooks remain — can't construct without on-chain address
  return hook;
}

export const isHookCompatible = ({
  hookType,
  chainTechnicalStack,
}: {
  hookType: HookType;
  chainTechnicalStack?: ChainTechnicalStack;
}): boolean =>
  !(
    hookType === HookType.AGGREGATION &&
    chainTechnicalStack === ChainTechnicalStack.ZkSync
  );
