import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

import {
  AggregationHookConfig,
  DerivedHookConfig,
  HookConfig,
  HookType,
} from './types.js';

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

export function hookTreeContainsRateLimited(
  hook: HookConfig | undefined,
): boolean {
  if (!hook || typeof hook === 'string') return false;
  if (hook.type === HookType.RATE_LIMITED) return true;
  if (hook.type === HookType.AGGREGATION) {
    return hook.hooks.some(hookTreeContainsRateLimited);
  }
  if (hook.type === HookType.ROUTING) {
    return Object.values(hook.domains).some(hookTreeContainsRateLimited);
  }
  if (hook.type === HookType.FALLBACK_ROUTING) {
    return (
      Object.values(hook.domains).some(hookTreeContainsRateLimited) ||
      hookTreeContainsRateLimited(hook.fallback)
    );
  }
  if (hook.type === HookType.AMOUNT_ROUTING) {
    return (
      hookTreeContainsRateLimited(hook.lowerHook) ||
      hookTreeContainsRateLimited(hook.upperHook)
    );
  }
  if (hook.type === HookType.ARB_L2_TO_L1) {
    return hookTreeContainsRateLimited(hook.childHook as HookConfig);
  }
  return false;
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
