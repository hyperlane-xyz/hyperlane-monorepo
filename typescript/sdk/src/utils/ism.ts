import { Address, WithAddress, assert, pick } from '@hyperlane-xyz/utils';

import { multisigIsmVerifyCosts } from '../consts/multisigIsmVerifyCosts.js';
import { HookConfig, HookType } from '../hook/types.js';
import {
  DelayedFlowRouterHookIsmConfig,
  IsmConfig,
  IsmType,
  NetFlowRateLimitedHookIsmConfig,
} from '../ism/types.js';

type ChainAddresses = Record<string, string>;

/**
 * Extracts the ISM and Hook factory addresses from chain-specific registry addresses
 * @param registryAddresses The registry addresses for a specific chain
 * @returns The extracted ISM and Hook factory addresses
 */
export function ismTreeContainsRateLimited(ism: unknown): boolean {
  if (typeof ism !== 'object' || ism === null) return false;
  const node = ism as Record<string, unknown>;
  if (node.type === IsmType.RATE_LIMITED) return true;
  if (Array.isArray(node.modules)) {
    if (node.modules.some(ismTreeContainsRateLimited)) return true;
  }
  if (node.domains !== null && typeof node.domains === 'object') {
    if (
      Object.values(node.domains as Record<string, unknown>).some(
        ismTreeContainsRateLimited,
      )
    )
      return true;
  }
  if (ismTreeContainsRateLimited(node.lowerIsm)) return true;
  if (ismTreeContainsRateLimited(node.upperIsm)) return true;
  return false;
}

/**
 * Recursively sets `recipient` on all RATE_LIMITED ISM nodes in the config tree.
 * Pass `undefined` to strip the field.
 * `defaultOwner` is set on nodes that don't have an explicit owner.
 */
export function setRateLimitedIsmRecipient(
  ismConfig: IsmConfig,
  recipient: Address | undefined,
  defaultOwner?: string,
): IsmConfig {
  if (typeof ismConfig === 'string') return ismConfig;

  if (ismConfig.type === IsmType.RATE_LIMITED) {
    return {
      ...ismConfig,
      recipient,
      ...(defaultOwner != null && ismConfig.owner == null
        ? { owner: defaultOwner }
        : {}),
    };
  }

  if (
    ismConfig.type === IsmType.AGGREGATION ||
    ismConfig.type === IsmType.STORAGE_AGGREGATION
  ) {
    return {
      ...ismConfig,
      modules: ismConfig.modules.map((m) =>
        setRateLimitedIsmRecipient(m, recipient, defaultOwner),
      ),
    };
  }

  if (
    ismConfig.type === IsmType.ROUTING ||
    ismConfig.type === IsmType.FALLBACK_ROUTING ||
    ismConfig.type === IsmType.INCREMENTAL_ROUTING
  ) {
    const newDomains: Record<string, IsmConfig> = {};
    for (const [domain, domainIsm] of Object.entries(ismConfig.domains)) {
      newDomains[domain] = setRateLimitedIsmRecipient(
        domainIsm,
        recipient,
        defaultOwner,
      );
    }
    return { ...ismConfig, domains: newDomains };
  }

  if (ismConfig.type === IsmType.AMOUNT_ROUTING) {
    return {
      ...ismConfig,
      lowerIsm: setRateLimitedIsmRecipient(
        ismConfig.lowerIsm,
        recipient,
        defaultOwner,
      ),
      upperIsm: setRateLimitedIsmRecipient(
        ismConfig.upperIsm,
        recipient,
        defaultOwner,
      ),
    };
  }

  return ismConfig;
}

export type HybridHookIsmConfig =
  | NetFlowRateLimitedHookIsmConfig
  | DelayedFlowRouterHookIsmConfig;

/**
 * True if a warp-route hybrid hook/ISM node (NET_FLOW_RATE_LIMITED or
 * DELAYED_FLOW_ROUTER) exists anywhere in the ISM config tree.
 */
export function ismTreeContainsHybridHookIsm(ism: unknown): boolean {
  return collectHybridIsmNodesFromUnknown(ism).length > 0;
}

/**
 * True if the ISM tree contains any node whose deployment must be deferred
 * until after the warp token exists: RATE_LIMITED (constructor needs the token
 * as recipient) and the hybrid hook/ISMs (constructor needs the token as
 * warpRouter).
 */
export function ismTreeContainsDeferredIsm(ism: unknown): boolean {
  return ismTreeContainsRateLimited(ism) || ismTreeContainsHybridHookIsm(ism);
}

/**
 * Deep-collects every hybrid hook/ISM node in an ISM config tree (including
 * derived trees, whose nodes additionally carry an `address` field).
 */
export function collectHybridIsmNodes(ism: IsmConfig): HybridHookIsmConfig[] {
  return collectHybridIsmNodesFromUnknown(ism);
}

/**
 * True if a hook config object is the hook-side view of a warp-route hybrid
 * hook/ISM. Those contracts are deployed through the ISM config surface and
 * merely referenced as the router's hook, so hook deployment paths must skip
 * them.
 */
export function isHybridHookConfig(hook: HookConfig): boolean {
  if (typeof hook !== 'object' || hook === null) return false;
  return (
    hook.type === HookType.NET_FLOW_RATE_LIMITED ||
    hook.type === HookType.DELAYED_FLOW_ROUTER
  );
}

function isHybridIsmNode(node: unknown): node is HybridHookIsmConfig {
  if (typeof node !== 'object' || node === null || !('type' in node)) {
    return false;
  }
  return (
    node.type === IsmType.NET_FLOW_RATE_LIMITED ||
    node.type === IsmType.DELAYED_FLOW_ROUTER
  );
}

function collectHybridIsmNodesFromUnknown(ism: unknown): HybridHookIsmConfig[] {
  if (typeof ism !== 'object' || ism === null) return [];
  if (isHybridIsmNode(ism)) return [ism];

  const node = ism as Record<string, unknown>;
  const collected: HybridHookIsmConfig[] = [];
  if (Array.isArray(node.modules)) {
    for (const module of node.modules) {
      collected.push(...collectHybridIsmNodesFromUnknown(module));
    }
  }
  if (node.domains !== null && typeof node.domains === 'object') {
    for (const domainIsm of Object.values(
      node.domains as Record<string, unknown>,
    )) {
      collected.push(...collectHybridIsmNodesFromUnknown(domainIsm));
    }
  }
  collected.push(...collectHybridIsmNodesFromUnknown(node.lowerIsm));
  collected.push(...collectHybridIsmNodesFromUnknown(node.upperIsm));
  return collected;
}

/**
 * Recursively maps every hybrid hook/ISM node in an ISM config tree
 * (traversing aggregation/routing/amount-routing containers), leaving all
 * other nodes untouched.
 */
function mapHybridIsmNodes(
  ismConfig: IsmConfig,
  mapNode: (node: HybridHookIsmConfig) => HybridHookIsmConfig,
): IsmConfig {
  if (typeof ismConfig === 'string') return ismConfig;

  if (
    ismConfig.type === IsmType.NET_FLOW_RATE_LIMITED ||
    ismConfig.type === IsmType.DELAYED_FLOW_ROUTER
  ) {
    return mapNode(ismConfig);
  }

  if (
    ismConfig.type === IsmType.AGGREGATION ||
    ismConfig.type === IsmType.STORAGE_AGGREGATION
  ) {
    return {
      ...ismConfig,
      modules: ismConfig.modules.map((m) => mapHybridIsmNodes(m, mapNode)),
    };
  }

  if (
    ismConfig.type === IsmType.ROUTING ||
    ismConfig.type === IsmType.FALLBACK_ROUTING ||
    ismConfig.type === IsmType.INCREMENTAL_ROUTING
  ) {
    const newDomains: Record<string, IsmConfig> = {};
    for (const [domain, domainIsm] of Object.entries(ismConfig.domains)) {
      newDomains[domain] = mapHybridIsmNodes(domainIsm, mapNode);
    }
    return { ...ismConfig, domains: newDomains };
  }

  if (ismConfig.type === IsmType.AMOUNT_ROUTING) {
    return {
      ...ismConfig,
      lowerIsm: mapHybridIsmNodes(ismConfig.lowerIsm, mapNode),
      upperIsm: mapHybridIsmNodes(ismConfig.upperIsm, mapNode),
    };
  }

  return ismConfig;
}

/**
 * Rejects combining a predicate wrapper with a hybrid hook/ISM.
 *
 * Both want to own the router's hook slot: the hybrid instance must BE the
 * hook (shared bucket state with its ISM role), while the predicate wrapper
 * installs `aggregation([wrapper, previousHook])`. Nesting the hybrid inside
 * that aggregation is mechanically possible — StaticAggregationHook forwards
 * each child its own `quoteDispatch` amount, which is what the hybrid's nested
 * `_Router_dispatch` needs — but only on the native-fee path: when the
 * dispatch metadata names a non-zero `feeToken`, the aggregation passes
 * `value: 0` to every child, starving the hybrid's nested dispatch. Until that
 * path is verified at the contract level, the combination is rejected rather
 * than silently producing a route whose policy hook or flow limiter is
 * missing from the dispatch path.
 *
 * TODO(hybrid+predicate composition verified): allow composing the two by
 * threading the hybrid address into PredicateWrapperDeployer.deployAndConfigure
 * as `existingHookOverride`.
 *
 * TODO(hybrid predicate guard on the deployer): a direct
 * `HypERC20Deployer.deploy(configMap, deferredIsms)` caller bypasses this
 * check — `deployPredicateWrappers` runs before `setDeferredIsms` and would
 * overwrite the hook. No in-repo caller does this today (executeWarpDeploy
 * asserts first), so the guard belongs in the deployer itself.
 */
export function assertNoPredicateWrapperWithHybridIsm(
  chain: string,
  config: { predicateWrapper?: unknown },
): void {
  assert(
    !config.predicateWrapper,
    `Hybrid hook/ISM and predicateWrapper are both configured on ${chain}, but both must own the router's hook. Remove one — composing them is not supported yet.`,
  );
}

/**
 * Fail-fast constraints for warp deploy configs whose ISM tree contains a
 * hybrid hook/ISM node, checked before any on-chain work: the deploy
 * machinery wires the single hybrid instance as the token's hook, so the
 * config must not be a foreignDeployment (nothing to wire), must not set
 * `hook` itself, and must contain exactly one hybrid node.
 */
export function assertHybridIsmDeployConstraints(
  chain: string,
  ism: IsmConfig,
  config: {
    hook?: HookConfig;
    foreignDeployment?: string;
    predicateWrapper?: unknown;
  },
): void {
  assertNoPredicateWrapperWithHybridIsm(chain, config);
  assert(
    !config.foreignDeployment,
    `Hybrid hook/ISM configured on ${chain} but it is a foreignDeployment — the hook cannot be wired post-deploy`,
  );
  assert(
    config.hook === undefined,
    `Hybrid hook/ISM configured on ${chain}: the hybrid instance is wired as the token's hook automatically, so 'hook' must be unset`,
  );
  const hybridNodes = collectHybridIsmNodes(ism);
  assert(
    hybridNodes.length === 1,
    `Expected exactly one hybrid hook/ISM node in the ISM tree on ${chain}, found ${hybridNodes.length} — only one instance can serve as the token's hook`,
  );
}

/**
 * Fills omitted NET_FLOW_RATE_LIMITED `owner` fields with `defaultOwner`,
 * mirroring `setRateLimitedIsmRecipient`'s defaultOwner semantics for the
 * RATE_LIMITED sibling. DELAYED_FLOW_ROUTER nodes are untouched (their owner
 * is schema-required). executeWarpDeploy applies this at snapshot time — the
 * deferred deploy pass runs with the intermediate (deployer) owner config, so
 * the user's configured owner is only available before that override.
 */
export function fillHybridIsmOwnerDefaults(
  ismConfig: IsmConfig,
  defaultOwner: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    if (node.type === IsmType.NET_FLOW_RATE_LIMITED && node.owner == null) {
      return {
        type: node.type,
        warpRouter: node.warpRouter,
        thresholdBps: node.thresholdBps,
        duration: node.duration,
        owner: defaultOwner,
      };
    }
    return node;
  });
}

/**
 * Prepares an ISM tree for the deferred (post-token) warp deploy pass:
 * injects `warpRouter` into every hybrid hook/ISM node; NET_FLOW nodes
 * lacking `owner` default to `defaultOwner` (the chain's config owner,
 * mirroring the RATE_LIMITED sibling); DELAYED_FLOW_ROUTER nodes get `owner`
 * overridden to the intermediate deployer and `remoteIsms` dropped — both are
 * applied later by the deployer-signed cross-chain enrollment pass, which
 * ends with the ownership transfer to the configured owner (enrollment is
 * owner-gated, so the deployer must still own the contract when it runs).
 * Sibling of `setRateLimitedIsmRecipient`.
 */
export function prepareHybridIsmNodesForDeploy(
  ismConfig: IsmConfig,
  warpRouter: Address,
  intermediateOwner: Address,
  defaultOwner: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    if (node.type === IsmType.NET_FLOW_RATE_LIMITED) {
      return {
        type: node.type,
        warpRouter,
        thresholdBps: node.thresholdBps,
        duration: node.duration,
        owner: node.owner ?? defaultOwner,
      };
    }
    return {
      type: node.type,
      warpRouter,
      thresholdBps: node.thresholdBps,
      maxDelay: node.maxDelay,
      duration: node.duration,
      owner: intermediateOwner,
    };
  });
}

/**
 * Completes hybrid hook/ISM nodes in an EXPECTED config tree with the values
 * the deploy machinery manages: `warpRouter` (the containing warp router),
 * the NET_FLOW `owner` default (the chain's config owner), and, for
 * DELAYED_FLOW_ROUTER, the `remoteIsms` pairing. User-specified values win.
 * Used by expandWarpDeployConfig so `warp check` compares complete
 * expectations against the fully-derived on-chain config.
 */
export function completeHybridIsmNodes(
  ismConfig: IsmConfig,
  warpRouter: Address,
  remoteIsms: Record<string, string> | undefined,
  defaultOwner: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    if (node.type === IsmType.NET_FLOW_RATE_LIMITED) {
      return {
        type: node.type,
        warpRouter: node.warpRouter ?? warpRouter,
        thresholdBps: node.thresholdBps,
        duration: node.duration,
        owner: node.owner ?? defaultOwner,
      };
    }
    return {
      type: node.type,
      warpRouter: node.warpRouter ?? warpRouter,
      thresholdBps: node.thresholdBps,
      maxDelay: node.maxDelay,
      duration: node.duration,
      owner: node.owner,
      remoteIsms: node.remoteIsms ?? remoteIsms,
    };
  });
}

export function extractIsmAndHookFactoryAddresses(
  registryAddresses: ChainAddresses,
) {
  return pick(registryAddresses as Record<string, string>, [
    'domainRoutingIsmFactory',
    'incrementalDomainRoutingIsmFactory',
    'staticMerkleRootMultisigIsmFactory',
    'staticMessageIdMultisigIsmFactory',
    'staticAggregationIsmFactory',
    'staticAggregationHookFactory',
    'staticMerkleRootWeightedMultisigIsmFactory',
    'staticMessageIdWeightedMultisigIsmFactory',
  ]);
}

export function multisigIsmVerificationCost(m: number, n: number): number {
  if (
    !(`${n}` in multisigIsmVerifyCosts) ||
    // @ts-ignore
    !(`${m}` in multisigIsmVerifyCosts[`${n}`])
  ) {
    throw new Error(`No multisigIsmVerificationCost found for ${m}-of-${n}`);
  }
  // @ts-ignore
  return multisigIsmVerifyCosts[`${n}`][`${m}`];
}

// Function to recursively remove 'address' properties and lowercase string properties
export function normalizeConfig(obj: WithAddress<any>): any {
  return sortArraysInConfig(lowerCaseConfig(obj));
}

function lowerCaseConfig(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(normalizeConfig);
  } else if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      if (key !== 'address' && key !== 'ownerOverrides') {
        newObj[key] = key === 'type' ? obj[key] : normalizeConfig(obj[key]);
      }
    }
    return newObj;
  } else if (typeof obj === 'string') {
    return obj.toLowerCase();
  }

  return obj;
}

// write a function that will go through an object and sort any arrays it finds
export function sortArraysInConfig(config: any): any {
  // Check if the current object is an array
  if (Array.isArray(config)) {
    return config.map(sortArraysInConfig);
  }
  // Check if it's an object and not null
  else if (typeof config === 'object' && config !== null) {
    const sortedConfig: any = {};
    for (const key in config) {
      if (key === 'validators' && Array.isArray(config[key])) {
        // Sort the validators array in lexicographical order (since they're already lowercase)
        sortedConfig[key] = [...config[key]].sort();
      }
      // if key is modules or hooks, sort the objects in the array by their 'type' property
      else if (
        (key === 'modules' || key === 'hooks') &&
        Array.isArray(config[key])
      ) {
        sortedConfig[key] = [...config[key]].sort((a: any, b: any) => {
          const aKey = typeof a === 'object' && a !== null ? a.type : String(a);
          const bKey = typeof b === 'object' && b !== null ? b.type : String(b);
          if (aKey < bKey) return -1;
          if (aKey > bKey) return 1;
          return 0;
        });
      } else {
        // Recursively apply sorting to other fields
        sortedConfig[key] = sortArraysInConfig(config[key]);
      }
    }
    return sortedConfig;
  }

  return config;
}
