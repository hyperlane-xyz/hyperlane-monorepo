import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  Address,
  assert,
  deepEquals,
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { HookConfig, HookConfigSchema, HookType } from '../hook/types.js';
import {
  collectHybridHookNodes,
  resolveHybridHookNodesToAddress,
} from '../hook/utils.js';
import { IsmConfig, IsmConfigSchema, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { WarpRouteDeployConfigMailboxRequired } from '../token/types.js';
import { ChainMap, ChainName } from '../types.js';
import {
  HybridHookIsmConfig,
  assertHybridIsmTokenTypeSupported,
  assertNoPredicateWrapperWithHybridIsm,
  canonicalHybridNode,
  collectHybridIsmNodes,
  prepareHybridIsmNodesForDeploy,
  resolveHybridIsmNodesToAddress,
} from '../utils/ism.js';

/**
 * One chain's share of a route's hybrid hook/ISM composition, resolved before
 * any gas is spent.
 *
 * A hybrid is a single contract instance installed as BOTH the router's hook
 * and its ISM — it meters flow on dispatch and preverifies on delivery out of
 * the same bucket state — so it is declared on both surfaces and both
 * declarations must name the same instance. This is the paired result.
 */
export type WarpHybridChainPlan = {
  chain: ChainName;
  /**
   * The agreed node, taken from the schema-parsed ISM tree. The hook tree's
   * declaration was compared against it field by field (canonicalHybridNode)
   * and carries no information this one lacks.
   */
  node: HybridHookIsmConfig;
  /** The schema-parsed ISM tree the node was found in. */
  ismTree: IsmConfig;
  /** The schema-parsed hook tree the node was found in. */
  hookTree: HookConfig;
};

/** The chains of a route that install a hybrid hook/ISM, keyed by chain. */
export type WarpHybridPlan = ChainMap<WarpHybridChainPlan>;

/**
 * Hook containers every dispatch necessarily flows through.
 *
 * A hybrid on the hook surface has to see EVERY dispatch out of the router:
 * DelayedFlowRouterHookIsm's postDispatch is what sends the preverification
 * its ISM side waits for, and NetFlowRateLimitedHookIsm's is what debits the
 * bucket its ISM side credits. A dispatch that bypasses it is either
 * permanently undeliverable (no preverification will ever exist for it) or
 * unmetered. Only an aggregation qualifies: StaticAggregationHook forwards
 * every child unconditionally, whereas the routing hooks pick one branch by
 * destination domain or amount, so a hybrid under one is skipped for every
 * dispatch that takes another branch.
 */
const UNCONDITIONAL_HOOK_CONTAINERS: ReadonlySet<string> = new Set<string>([
  HookType.AGGREGATION,
]);

function assertHybridHookPositionUnconditional(
  chain: ChainName,
  hook: HookConfig,
  ancestors: string[] = [],
): void {
  if (typeof hook === 'string') return;

  if (
    hook.type === HookType.NET_FLOW_RATE_LIMITED ||
    hook.type === HookType.DELAYED_FLOW_ROUTER
  ) {
    const conditional = ancestors.filter(
      (type) => !UNCONDITIONAL_HOOK_CONTAINERS.has(type),
    );
    assert(
      conditional.length === 0,
      `Hybrid hook/ISM (${hook.type}) on ${chain} sits under ${conditional.join(' -> ')}, which only forwards some dispatches. It must see every dispatch out of the router — the ones it misses are either unmetered or, for ${IsmType.DELAYED_FLOW_ROUTER}, permanently undeliverable because no preverification is ever sent for them. Declare it at the top level or inside an ${HookType.AGGREGATION}.`,
    );
    return;
  }

  const nextAncestors = [...ancestors, hook.type];
  switch (hook.type) {
    case HookType.AGGREGATION:
      for (const child of hook.hooks) {
        assertHybridHookPositionUnconditional(chain, child, nextAncestors);
      }
      return;
    case HookType.ROUTING:
      for (const child of Object.values(hook.domains)) {
        assertHybridHookPositionUnconditional(chain, child, nextAncestors);
      }
      return;
    case HookType.FALLBACK_ROUTING:
      for (const child of Object.values(hook.domains)) {
        assertHybridHookPositionUnconditional(chain, child, nextAncestors);
      }
      assertHybridHookPositionUnconditional(
        chain,
        hook.fallback,
        nextAncestors,
      );
      return;
    case HookType.AMOUNT_ROUTING:
      assertHybridHookPositionUnconditional(
        chain,
        hook.lowerHook,
        nextAncestors,
      );
      assertHybridHookPositionUnconditional(
        chain,
        hook.upperHook,
        nextAncestors,
      );
      return;
    case HookType.ARB_L2_TO_L1:
      assertHybridHookPositionUnconditional(
        chain,
        hook.childHook,
        nextAncestors,
      );
      return;
    default:
      return;
  }
}

/**
 * The slice of a chain's warp config the hybrid rules read. Kept structural so
 * `warp apply`, which holds an expected config rather than a deploy config, can
 * be validated by exactly the same code.
 */
export type HybridChainConfig = {
  interchainSecurityModule?: unknown;
  hook?: unknown;
  owner?: Address;
  feeHook?: Address;
  type?: WarpRouteDeployConfigMailboxRequired[string]['type'];
  foreignDeployment?: string;
  predicateWrapper?: unknown;
};

/**
 * Runs the full schema refinement over a chain's declarative hook and ISM
 * trees. `IsmConfigSchema` carries the composition rules the hybrid types
 * depend on (mandatory aggregation position, an authenticating sibling), so
 * this is what turns "the config mentions a hybrid" into "the config is one
 * this deploy can honour".
 */
function parseChainTrees(
  chain: ChainName,
  config: HybridChainConfig,
): { ism: IsmConfig | undefined; hook: HookConfig | undefined } {
  const ism =
    config.interchainSecurityModule === undefined
      ? undefined
      : IsmConfigSchema.parse(config.interchainSecurityModule);
  const hook =
    config.hook === undefined ? undefined : HookConfigSchema.parse(config.hook);
  assert(
    ism !== null && hook !== null,
    `Null hook or interchainSecurityModule on ${chain} — omit the field instead`,
  );
  return { ism, hook };
}

/**
 * Resolves the hybrid hook/ISM composition of a warp route without spending
 * any gas: it parses both config trees through their full schemas, finds the
 * hybrid node on each surface, checks that the two declarations describe one
 * instance, and validates everything about that instance which is decidable
 * from the config (protocol, token type, hook position, no competing
 * predicate wrapper, not a foreignDeployment).
 *
 * Every check here is per chain, so the result on a subset of a route is the
 * same as on the whole route. The invariants whose verdict depends on WHICH
 * chains the config contains — a delayed-flow route needs an instance on every
 * leg, and external `remoteRouters` need explicit peers — live in
 * `assertDelayedFlowRouteCoverage`, which only the whole-route entry points
 * run.
 */
export function planWarpRouteHybrids({
  multiProvider,
  warpDeployConfig,
}: {
  multiProvider: MultiProvider;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}): WarpHybridPlan {
  const plan: WarpHybridPlan = {};
  for (const [chain, config] of Object.entries(warpDeployConfig)) {
    const entry = planChainHybrid({ multiProvider, chain, config });
    if (entry) plan[chain] = entry;
  }
  return plan;
}

/**
 * `planWarpRouteHybrids` for a single chain. `warp apply` reaches this directly:
 * it plans one router at a time and must apply exactly the same rules the
 * deploy path does, including the schema refinement, so that a config it
 * accepts is one a fresh deploy would accept too.
 */
export function planChainHybrid({
  multiProvider,
  chain,
  config,
}: {
  multiProvider: MultiProvider;
  chain: ChainName;
  config: HybridChainConfig;
}): WarpHybridChainPlan | undefined {
  const { ism, hook } = parseChainTrees(chain, config);

  const ismNodes = ism ? collectHybridIsmNodes(ism) : [];
  const hookNodes = collectHybridHookNodes(hook);
  if (ismNodes.length === 0 && hookNodes.length === 0) return undefined;

  // One instance per chain, on each surface. Two would each want to be the
  // router's single hook, and the second would silently never be installed.
  assert(
    ismNodes.length === 1,
    `Expected exactly one hybrid hook/ISM node in the 'interchainSecurityModule' tree on ${chain}, found ${ismNodes.length} — a router installs one hook, so only one instance can serve both roles`,
  );
  assert(
    hookNodes.length === 1,
    hookNodes.length === 0
      ? `${ismNodes[0].type} is declared in the 'interchainSecurityModule' tree on ${chain} but not in the 'hook' tree. One contract instance serves both roles — it preverifies inbound messages only for the dispatches it metered — so declare the same node under 'hook' too.`
      : `Expected exactly one hybrid hook/ISM node in the 'hook' tree on ${chain}, found ${hookNodes.length} — a router installs one hook, so only one instance can serve both roles`,
  );

  const protocol = multiProvider.getProtocol(chain);
  assert(
    protocol === ProtocolType.Ethereum || protocol === ProtocolType.Tron,
    `Hybrid hook/ISM (${ismNodes[0].type}) configured on ${chain}, whose protocol is ${protocol} — the contract only exists on Ethereum and Tron chains`,
  );
  assert(
    !config.foreignDeployment,
    `Hybrid hook/ISM configured on ${chain} but it is a foreignDeployment — this deploy owns neither the router nor the instance, so it can wire neither`,
  );
  assertNoPredicateWrapperWithHybridIsm(chain, config);
  assertHybridIsmTokenTypeSupported(chain, config.type);
  assert(hook, `Unreachable: a hybrid hook node was found on ${chain}`);
  assertHybridHookPositionUnconditional(chain, hook);

  // The two surfaces are separate config unions that happen to share these
  // field names, so they are compared through one canonical form rather than
  // by structural type equality.
  const context = `Hybrid hook/ISM on ${chain}`;
  const ismNode = canonicalHybridNode(ismNodes[0], multiProvider, context);
  const hookNode = canonicalHybridNode(hookNodes[0], multiProvider, context);
  assert(
    deepEquals(ismNode, hookNode),
    `${context} is declared differently on the two surfaces: 'interchainSecurityModule' says ${JSON.stringify(ismNode)} while 'hook' says ${JSON.stringify(hookNode)}. One contract instance is installed as both, so the two declarations must be identical.`,
  );
  assert(
    ismNodes[0].type !== IsmType.DELAYED_FLOW_ROUTER ||
      !config.feeHook ||
      isZeroishAddress(config.feeHook),
    `${IsmType.DELAYED_FLOW_ROUTER} on ${chain} cannot be combined with non-zero feeHook ${config.feeHook}. Its control dispatch quotes native fees, but TokenRouter labels and charges that quote as ERC20 when feeHook is enabled, so standard transfer callers supply no native value and the control dispatch can revert. Clear feeHook before configuring ${IsmType.DELAYED_FLOW_ROUTER}.`,
  );

  assert(config.owner, `Missing warp router owner on ${chain}`);
  const hybridOwner = ismNodes[0].owner ?? config.owner;
  assert(
    eqAddress(hybridOwner, config.owner),
    `${context} is owned by ${hybridOwner}, but the warp router is owned by ${config.owner}. Warp apply uses one submitter per chain for every non-fee mutation, so a hybrid hook/ISM must share the router's owner.`,
  );

  assert(ism, `Unreachable: a hybrid ISM node was found on ${chain}`);
  return {
    chain,
    node: ismNodes[0],
    ismTree: ism,
    hookTree: hook,
  };
}

/**
 * The config the hybrid leaf is deployed from: the planned node bound to the
 * router it guards, with the ownership the deploy needs while it is still
 * wiring things up.
 *
 * Every hybrid stays owned by the deployer here so its owner matches the
 * freshly deployed warp router throughout route wiring. Ownership moves to the
 * configured owner in the route's final pass.
 */
export function hybridLeafDeployConfig({
  entry,
  warpRouter,
  deployerAddress,
}: {
  entry: WarpHybridChainPlan;
  warpRouter: Address;
  deployerAddress: Address;
}): HybridHookIsmConfig {
  const prepared = prepareHybridIsmNodesForDeploy(
    entry.node,
    warpRouter,
    deployerAddress,
  );
  assert(
    typeof prepared === 'object' &&
      (prepared.type === IsmType.NET_FLOW_RATE_LIMITED ||
        prepared.type === IsmType.DELAYED_FLOW_ROUTER),
    `Unreachable: preparing the hybrid leaf on ${entry.chain} did not yield a hybrid node`,
  );
  return prepared;
}

/**
 * The parent trees to hand to EvmIsmModule / EvmHookModule once the shared
 * instance exists: the same trees the plan captured, with the hybrid node on
 * each surface replaced by that one address.
 *
 * Substituting rather than re-declaring is the point — a second declaration
 * would deploy a second contract with its own bucket, and the router would
 * meter dispatches against one while preverifying deliveries against the
 * other.
 */
export function resolveHybridTrees(
  entry: WarpHybridChainPlan,
  hybridAddress: Address,
): { ism: IsmConfig; hook: HookConfig } {
  return {
    ism: resolveHybridIsmNodesToAddress(entry.ismTree, hybridAddress),
    hook: resolveHybridHookNodesToAddress(entry.hookTree, hybridAddress),
  };
}
