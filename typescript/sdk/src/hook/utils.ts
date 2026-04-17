import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

import { AggregationHookConfig, DerivedHookConfig, HookType } from './types.js';

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
