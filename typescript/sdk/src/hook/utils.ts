import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

import {
  AggregationHookConfig,
  DerivedHookConfig,
  HookConfig,
  HookType,
  IgpVersion,
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

function hookTreeContains(
  hook: HookConfig | undefined,
  predicate: (hook: Exclude<HookConfig, string>) => boolean,
): boolean {
  if (!hook || typeof hook === 'string') return false;
  if (predicate(hook)) return true;
  if (hook.type === HookType.AGGREGATION) {
    return hook.hooks.some((child) => hookTreeContains(child, predicate));
  }
  if (hook.type === HookType.ROUTING) {
    return Object.values(hook.domains).some((child) =>
      hookTreeContains(child, predicate),
    );
  }
  if (hook.type === HookType.FALLBACK_ROUTING) {
    return (
      Object.values(hook.domains).some((child) =>
        hookTreeContains(child, predicate),
      ) || hookTreeContains(hook.fallback, predicate)
    );
  }
  if (hook.type === HookType.AMOUNT_ROUTING) {
    return (
      hookTreeContains(hook.lowerHook, predicate) ||
      hookTreeContains(hook.upperHook, predicate)
    );
  }
  if (hook.type === HookType.ARB_L2_TO_L1) {
    return hookTreeContains(hook.childHook as HookConfig, predicate);
  }
  return false;
}

export function hookTreeContainsRateLimited(
  hook: HookConfig | undefined,
): boolean {
  return hookTreeContains(hook, (node) => node.type === HookType.RATE_LIMITED);
}

export function hookTreeContainsLegacyIgp(
  hook: HookConfig | undefined,
): boolean {
  return hookTreeContains(
    hook,
    (node) =>
      node.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      node.igpVersion === IgpVersion.Legacy,
  );
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
