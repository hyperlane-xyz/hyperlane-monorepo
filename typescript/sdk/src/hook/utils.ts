import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';

import {
  AggregationHookConfig,
  DelayedFlowRouterHookConfig,
  DerivedHookConfig,
  HookConfig,
  HookType,
  IgpVersion,
  NetFlowRateLimitedHookConfig,
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
    return hookTreeContains(hook.childHook, predicate);
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

/**
 * The hook-surface view of a warp-route hybrid hook/ISM. One contract instance
 * is installed as BOTH the router's hook and its ISM, so the same node is
 * declared on both surfaces; the ISM-surface counterpart lives in
 * ../ism/types.js and shares these `type` strings.
 */
export type HybridHookNodeConfig =
  | NetFlowRateLimitedHookConfig
  | DelayedFlowRouterHookConfig;

export function isHybridHookNode(
  hook: HookConfig | undefined,
): hook is HybridHookNodeConfig {
  return (
    !!hook &&
    typeof hook === 'object' &&
    (hook.type === HookType.NET_FLOW_RATE_LIMITED ||
      hook.type === HookType.DELAYED_FLOW_ROUTER)
  );
}

/**
 * Rebuilds a hook tree, applying `mapNode` to every hybrid hook/ISM node and
 * leaving every other node identical. The traversal covers the same containers
 * as `hookTreeContains`, so the two agree on what "in the tree" means.
 */
export function mapHybridHookNodes(
  hook: HookConfig,
  mapNode: (node: HybridHookNodeConfig) => HookConfig,
): HookConfig {
  if (typeof hook === 'string') return hook;
  if (isHybridHookNode(hook)) return mapNode(hook);

  switch (hook.type) {
    case HookType.AGGREGATION:
      return {
        ...hook,
        hooks: hook.hooks.map((child) => mapHybridHookNodes(child, mapNode)),
      };
    case HookType.ROUTING:
      return {
        ...hook,
        domains: Object.fromEntries(
          Object.entries(hook.domains).map(([domain, child]) => [
            domain,
            mapHybridHookNodes(child, mapNode),
          ]),
        ),
      };
    case HookType.FALLBACK_ROUTING:
      return {
        ...hook,
        domains: Object.fromEntries(
          Object.entries(hook.domains).map(([domain, child]) => [
            domain,
            mapHybridHookNodes(child, mapNode),
          ]),
        ),
        fallback: mapHybridHookNodes(hook.fallback, mapNode),
      };
    case HookType.AMOUNT_ROUTING:
      return {
        ...hook,
        lowerHook: mapHybridHookNodes(hook.lowerHook, mapNode),
        upperHook: mapHybridHookNodes(hook.upperHook, mapNode),
      };
    case HookType.ARB_L2_TO_L1:
      return {
        ...hook,
        childHook: mapHybridHookNodes(hook.childHook, mapNode),
      };
    default:
      return hook;
  }
}

/** Every hybrid hook/ISM node declared anywhere in a hook tree. */
export function collectHybridHookNodes(
  hook: HookConfig | undefined,
): HybridHookNodeConfig[] {
  if (!hook) return [];
  const collected: HybridHookNodeConfig[] = [];
  mapHybridHookNodes(hook, (node) => {
    collected.push(node);
    return node;
  });
  return collected;
}

export function hookTreeContainsHybridHookIsm(
  hook: HookConfig | undefined,
): boolean {
  return collectHybridHookNodes(hook).length > 0;
}

/**
 * Replaces every hybrid hook/ISM node in a hook tree with the address of the
 * deployed instance, so the remaining parent tree can be handed to
 * EvmHookModule — which deploys parents but rejects the hybrid types, whose
 * single instance is deployed once and shared with the ISM surface.
 */
export function resolveHybridHookNodesToAddress(
  hook: HookConfig,
  address: Address,
): HookConfig {
  return mapHybridHookNodes(hook, () => address);
}

/** ISM-side counterpart: collapse only an already-installed matching leaf. */
export function collapseMatchingHybridHookNodes(
  hook: HookConfig,
  address: Address,
): HookConfig {
  return mapHybridHookNodes(hook, (node) => {
    const derivedAddress =
      'address' in node && typeof node.address === 'string'
        ? node.address
        : undefined;
    return derivedAddress && eqAddress(derivedAddress, address)
      ? address
      : node;
  });
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
