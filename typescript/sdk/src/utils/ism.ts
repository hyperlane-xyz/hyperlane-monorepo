import {
  Address,
  WithAddress,
  addressToBytes32,
  assert,
  deepEquals,
  eqAddress,
  pick,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { multisigIsmVerifyCosts } from '../consts/multisigIsmVerifyCosts.js';
import { TokenType } from '../token/config.js';
import {
  DelayedFlowRouterHookIsmConfig,
  IsmConfig,
  IsmType,
  NetFlowRateLimitedHookIsmConfig,
} from '../ism/types.js';

type ChainAddresses = Record<string, string>;

const logger = rootLogger.child({ module: 'IsmConfigUtils' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
 * True if a MAILBOX_DEFAULT or hybrid hook/ISM node exists anywhere in the
 * tree. Used to keep warp-route-only and self-referential ISM types out of
 * core default-ISM configs (see core/types.ts).
 */
export function ismTreeContainsMailboxDefaultOrHybrid(ism: unknown): boolean {
  return (
    ismTreeContainsHybridHookIsm(ism) ||
    ismTreeSome(ism, (node) => node.type === IsmType.MAILBOX_DEFAULT)
  );
}

/**
 * Deep-collects every hybrid hook/ISM node in an ISM config tree (including
 * derived trees, whose nodes additionally carry an `address` field).
 */
export function collectHybridIsmNodes(ism: IsmConfig): HybridHookIsmConfig[] {
  return collectHybridIsmNodesFromUnknown(ism);
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

/** True if any node in the tree satisfies `matches`. */
function ismTreeSome(
  ism: unknown,
  matches: (node: Record<string, unknown>) => boolean,
): boolean {
  if (!isRecord(ism)) return false;
  const node = ism;
  if (matches(node)) return true;

  if (Array.isArray(node.modules)) {
    if (node.modules.some((module) => ismTreeSome(module, matches)))
      return true;
  }
  if (isRecord(node.domains)) {
    const domains = Object.values(node.domains);
    if (domains.some((domainIsm) => ismTreeSome(domainIsm, matches)))
      return true;
  }
  return (
    ismTreeSome(node.lowerIsm, matches) || ismTreeSome(node.upperIsm, matches)
  );
}

function collectHybridIsmNodesFromUnknown(ism: unknown): HybridHookIsmConfig[] {
  if (!isRecord(ism)) return [];
  if (isHybridIsmNode(ism)) return [ism];

  const node = ism;
  const collected: HybridHookIsmConfig[] = [];
  if (Array.isArray(node.modules)) {
    for (const module of node.modules) {
      collected.push(...collectHybridIsmNodesFromUnknown(module));
    }
  }
  if (isRecord(node.domains)) {
    for (const domainIsm of Object.values(node.domains)) {
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
export function mapHybridIsmNodes(
  ismConfig: IsmConfig,
  mapNode: (node: HybridHookIsmConfig) => IsmConfig,
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
 */
export function assertNoPredicateWrapperWithHybridIsm(
  chain: string,
  config: unknown,
): void {
  const predicateWrapper =
    typeof config === 'object' &&
    config !== null &&
    'predicateWrapper' in config
      ? config.predicateWrapper
      : undefined;
  assert(
    !predicateWrapper,
    `Hybrid hook/ISM and predicateWrapper are both configured on ${chain}, but both must own the router's hook. Remove one — composing them is not supported yet.`,
  );
}

/**
 * Warp router implementations a hybrid hook/ISM may guard.
 *
 * NetFlowRateLimitedHookIsm sizes its bucket from the paired router's TVL via
 * two arms (see the contract docstring, solidity/contracts/hooks/warp-route/
 * NetFlowRateLimitedHookIsm.sol:31-41):
 *   - synthetic (`token() == warpRouter`): reads `totalSupply()`;
 *   - collateral/native: reads the balance minus `totalAssets()`, which
 *     requires the router to be an `LpCollateralRouter`.
 *
 * Verified against the contract hierarchy rather than the docstring's prose:
 *   - `HypNative` and `HypERC20Collateral` are the only direct
 *     `LpCollateralRouter` subclasses (HypNative.sol:19,
 *     HypERC20Collateral.sol:35);
 *   - `crossCollateral` qualifies transitively, since
 *     `CrossCollateralRouter is HypERC20Collateral`
 *     (CrossCollateralRouter.sol:46-47);
 *   - the rejected collateral-ish types extend `TokenRouter` directly, not
 *     `LpCollateralRouter`, so `localCollateral()` would revert
 *     (HypERC4626Collateral, HypFiatToken, HypXERC20, HypXERC20Lockbox).
 *
 * Membership is NOT derived from inheritance, deliberately: `HypERC4626` (the
 * `syntheticRebase` type) *is* a subclass of the permitted `HypERC20`, but it
 * rebases, so `_toLocalAmount` would meter shares against an asset-denominated
 * bucket. An inheritance-derived rule would silently admit it.
 */
const HYBRID_ISM_SUPPORTED_TOKEN_TYPES: ReadonlySet<TokenType> =
  new Set<TokenType>([
    TokenType.synthetic,
    TokenType.collateral,
    TokenType.native,
    // Alias of `native`: same HypNative factory (token/contracts.ts), so it is
    // contract-identical to an accepted type.
    TokenType.nativeScaled,
    TokenType.crossCollateral,
  ]);

/**
 * Rejects a hybrid hook/ISM on a router implementation it cannot meter.
 *
 * Enforced on every path that can install a hybrid on a router — deploy
 * (assertHybridIsmDeployConstraints) and `warp apply`
 * (EvmWarpModule.createHookAndPredicateUpdateTxs). A hybrid on, say, a
 * collateralVault router deploys fine (the constructor only reads `token()`)
 * and then reverts on every dispatch and delivery, because `localCollateral()`
 * calls `totalAssets()` on a router that is not an `LpCollateralRouter`.
 */
export function assertHybridIsmTokenTypeSupported(
  chain: string,
  type: TokenType | undefined,
): void {
  assert(
    type !== undefined && HYBRID_ISM_SUPPORTED_TOKEN_TYPES.has(type),
    `Hybrid hook/ISM configured on ${chain} for token type '${type}', which it cannot meter. Supported: ${[...HYBRID_ISM_SUPPORTED_TOKEN_TYPES].join(', ')}.`,
  );
}

/**
 * Replaces every hybrid hook/ISM node in an ISM tree with the address of the
 * already-deployed instance.
 *
 * The hybrid leaf is deployed exactly once per chain and shared between the
 * router's hook and ISM surfaces, so the parent tree handed to EvmIsmModule
 * must reference it by address rather than re-declaring it — otherwise the
 * parent deploy would mint a second instance with its own bucket state.
 * Sibling of `resolveHybridHookNodesToAddress` on the hook surface.
 */
export function resolveHybridIsmNodesToAddress(
  ismConfig: IsmConfig,
  address: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, () => address);
}

/**
 * Collapses only derived hybrid nodes that already name `address`.
 * Used when comparing an on-chain tree with a target whose shared hybrid leaf
 * is intentionally opaque; an older leaf must remain visible as a difference.
 */
export function collapseMatchingHybridIsmNodes(
  ismConfig: IsmConfig,
  address: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    const derivedAddress =
      'address' in node && typeof node.address === 'string'
        ? node.address
        : undefined;
    return derivedAddress && eqAddress(derivedAddress, address)
      ? address
      : node;
  });
}

/**
 * The comparable form of a hybrid hook/ISM node: the fields that identify the
 * contract instance the config asks for, with addresses lowercased, `duration`
 * stringified (it parses to a bigint, which `deepEquals` cannot compare across
 * separately-parsed copies) and `remoteIsms` canonicalized.
 *
 * A hybrid is declared on BOTH the hook and the ISM surface of the same
 * router, and one instance has to satisfy both, so the two declarations are
 * compared through here — a difference in any of these fields would otherwise
 * be silently resolved in favour of whichever surface the deploy read first.
 * `address` is deliberately absent: a derived tree carries one, a config tree
 * does not, and comparing them is the caller's job.
 */
export function canonicalHybridNode(
  node: HybridHookIsmConfig,
  chainLookup: RemoteIsmChainLookup,
  context: string,
): Record<string, unknown> {
  const common = {
    type: node.type,
    warpRouter: node.warpRouter?.toLowerCase(),
    thresholdBps: node.thresholdBps,
    duration: node.duration.toString(),
    owner: node.owner?.toLowerCase(),
  };
  if (node.type === IsmType.NET_FLOW_RATE_LIMITED) return common;
  return {
    ...common,
    maxDelay: node.maxDelay,
    remoteIsms: node.remoteIsms
      ? canonicalizeRemoteIsms(node.remoteIsms, chainLookup, context)
      : undefined,
  };
}

/**
 * Resolves the `warpRouter` a hybrid hook/ISM node is deployed against, which
 * is always the router the node's tree is installed on.
 *
 * A hybrid meters exactly one router and checks it on both sides — postDispatch
 * reverts `WrongSender` when the dispatching router is not `warpRouter`, and
 * verify reverts `WrongRecipient` when the delivering router is not
 * `warpRouter` (NetFlowRateLimitedHookIsm.sol:97-106) — so a node naming a
 * foreign router is always wrong. Rejected rather than silently rewritten: the
 * user asked for a pairing the deploy cannot honour, and rewriting an explicit
 * value hides that.
 */
function resolveHybridWarpRouter(
  node: HybridHookIsmConfig,
  warpRouter: Address,
): Address {
  assert(
    node.warpRouter === undefined || eqAddress(node.warpRouter, warpRouter),
    `Hybrid hook/ISM (${node.type}) sets warpRouter ${node.warpRouter}, but it is installed on warp router ${warpRouter}. A hybrid guards exactly the router it is installed on, so it would reject that router's traffic. Unset 'warpRouter' or set it to ${warpRouter}.`,
  );
  return warpRouter;
}

/**
 * Prepares an ISM tree for the deferred (post-token) warp deploy pass:
 * injects `warpRouter` into every hybrid hook/ISM node and overrides `owner`
 * to the intermediate deployer. DELAYED_FLOW_ROUTER `remoteIsms` are also
 * dropped. The deployer-signed cross-chain enrollment pass applies the final
 * configuration and ends with the ownership transfer to the configured owner.
 * Sibling of `setRateLimitedIsmRecipient`.
 */
export function prepareHybridIsmNodesForDeploy(
  ismConfig: IsmConfig,
  warpRouter: Address,
  intermediateOwner: Address,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    const resolvedWarpRouter = resolveHybridWarpRouter(node, warpRouter);
    if (node.type === IsmType.NET_FLOW_RATE_LIMITED) {
      return {
        type: node.type,
        warpRouter: resolvedWarpRouter,
        thresholdBps: node.thresholdBps,
        duration: node.duration,
        owner: intermediateOwner,
      };
    }
    return {
      type: node.type,
      warpRouter: resolvedWarpRouter,
      thresholdBps: node.thresholdBps,
      maxDelay: node.maxDelay,
      duration: node.duration,
      owner: intermediateOwner,
    };
  });
}

/**
 * How `completeHybridIsmNodes` fills a DELAYED_FLOW_ROUTER's `remoteIsms`.
 */
export const DelayedFlowRemoteIsmsSourceType = {
  /** Resolve the field with resolveDelayedFlowRemoteIsms. */
  Resolved: 'resolved',
  /**
   * Leave the field unset, which makes consumers preserve the current on-chain
   * enrollment. For paths that run beside the cross-chain enrollment pass
   * (buildDelayedFlowEnrollmentTxs): it is the enrollment's only writer, and
   * two writers planning the same enrollment emit it twice.
   */
  Deferred: 'deferred',
} as const;

export type DelayedFlowRemoteIsmsSource =
  | {
      type: typeof DelayedFlowRemoteIsmsSourceType.Resolved;
      /** Pairing derived from the route, or undefined when it is unknown here. */
      derived: Record<string, string> | undefined;
    }
  | { type: typeof DelayedFlowRemoteIsmsSourceType.Deferred };

/**
 * Minimal chain-resolution surface `canonicalizeRemoteIsms` needs. MultiProvider
 * satisfies it structurally, which keeps this module free of that import.
 */
export interface RemoteIsmChainLookup {
  tryGetDomainId(chainNameOrId: string | number): number | null;
  tryGetChainName(chainNameOrId: string | number): string | null;
}

/**
 * The single representation of a DelayedFlowRouterHookIsm's `remoteIsms`:
 * canonical chain name -> lowercase bytes32, which is exactly what the reader
 * emits (deriveDelayedFlowRemoteIsms). Deploy, update and check all resolve the
 * field through here, so they enroll, diff and compare the same entries.
 *
 * Both key forms a user can write are accepted and collapse to the chain name:
 * a name, and the chain's domain id. Neither is left ambiguous — a key that
 * resolves to no known chain is rejected rather than skipped (it would
 * otherwise pass a config-level preflight and only fail once contracts are
 * deployed), and two keys naming the same chain are rejected too (a single
 * on-chain entry per domain cannot satisfy both, so the config could never
 * converge).
 */
export function canonicalizeRemoteIsms(
  remoteIsms: Record<string, string>,
  chainLookup: RemoteIsmChainLookup,
  context: string,
): Record<string, string> {
  const keyByDomain = new Map<number, string>();
  const canonical: Record<string, string> = {};

  for (const [key, router] of Object.entries(remoteIsms)) {
    const domainId = chainLookup.tryGetDomainId(key);
    assert(
      domainId !== null,
      `${context} names '${key}' under 'remoteIsms', which resolves to no known chain — use the chain's registry name or its domain id (note that a chain id is neither)`,
    );
    const chainName = chainLookup.tryGetChainName(domainId);
    assert(
      chainName !== null,
      `${context} names '${key}' under 'remoteIsms', which resolves to domain ${domainId} but to no chain name — add the chain to the registry`,
    );
    const previousKey = keyByDomain.get(domainId);
    assert(
      previousKey === undefined,
      `${context} names both '${previousKey}' and '${key}' under 'remoteIsms', which are the same chain ${chainName} (domain ${domainId}). A domain has a single enrolled counterpart on-chain, so the two entries can never both hold — keep one.`,
    );
    keyByDomain.set(domainId, key);
    canonical[chainName] = addressToBytes32(router).toLowerCase();
  }

  return canonical;
}

function normalizeRemoteIsms(
  remoteIsms: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [chain, router] of Object.entries(remoteIsms)) {
    normalized[chain] = addressToBytes32(router).toLowerCase();
  }
  return normalized;
}

/**
 * Single source of truth for a DelayedFlowRouterHookIsm's `remoteIsms`: both
 * the expected config `warp check` compares and the enrollment transactions
 * `warp apply` emits resolve the field through here, so they cannot disagree
 * (they once did, and the route never converged).
 *
 * Route-derived peers are authoritative for chains in the route: their
 * addresses can change during replacement, while `warp read` still contains
 * the installed instances' old enrollment. Configured entries are retained
 * for external chains the route cannot derive, preserving unusual topologies.
 */
export function resolveDelayedFlowRemoteIsms(
  configured: Record<string, string> | undefined,
  derived: Record<string, string> | undefined,
  context: string,
  chainLookup: RemoteIsmChainLookup,
): Record<string, string> | undefined {
  if (configured === undefined) {
    return derived;
  }

  // Canonicalized here rather than at each consumer: whatever key form the
  // config used, everything downstream sees the one representation.
  const canonical = canonicalizeRemoteIsms(configured, chainLookup, context);

  if (derived === undefined) {
    return canonical;
  }

  const normalizedDerived = normalizeRemoteIsms(derived);
  const resolved = { ...canonical, ...normalizedDerived };

  if (!deepEquals(canonical, resolved)) {
    logger.warn(
      `${context} configures in-route 'remoteIsms' that differ from the current route pairing. The route-derived peers win; configured external peers are retained.`,
    );
  }

  return resolved;
}

/**
 * Completes hybrid hook/ISM nodes in an EXPECTED config tree with the values
 * the deploy machinery manages: `warpRouter` (the containing warp router,
 * always injected — see resolveHybridWarpRouter), the NET_FLOW `owner` default
 * (the chain's config owner, when the node omits one), and, for
 * DELAYED_FLOW_ROUTER, the `remoteIsms` pairing. Used by
 * expandWarpDeployConfig so `warp check` compares complete expectations
 * against the fully-derived on-chain config, and by EvmWarpModule so `warp
 * apply` plans against the same complete config.
 *
 * `defaultOwner` is only consulted for a NET_FLOW node that omits `owner`
 * (DELAYED_FLOW_ROUTER's is schema-required), so callers that cannot resolve
 * an owner still get `warpRouter` filled.
 */
export function completeHybridIsmNodes(
  ismConfig: IsmConfig,
  warpRouter: Address,
  remoteIsms: DelayedFlowRemoteIsmsSource,
  defaultOwner: Address | undefined,
  chainLookup: RemoteIsmChainLookup,
): IsmConfig {
  return mapHybridIsmNodes(ismConfig, (node) => {
    const resolvedWarpRouter = resolveHybridWarpRouter(node, warpRouter);
    if (node.type === IsmType.NET_FLOW_RATE_LIMITED) {
      const owner = node.owner ?? defaultOwner;
      assert(
        owner,
        `Hybrid hook/ISM (${node.type}) on warp router ${warpRouter} omits 'owner' and no owner could be resolved for the route — set 'owner' on the ISM config`,
      );
      return {
        type: node.type,
        warpRouter: resolvedWarpRouter,
        thresholdBps: node.thresholdBps,
        duration: node.duration,
        owner,
      };
    }
    return {
      type: node.type,
      warpRouter: resolvedWarpRouter,
      thresholdBps: node.thresholdBps,
      maxDelay: node.maxDelay,
      duration: node.duration,
      owner: node.owner,
      remoteIsms:
        remoteIsms.type === DelayedFlowRemoteIsmsSourceType.Deferred
          ? undefined
          : resolveDelayedFlowRemoteIsms(
              node.remoteIsms,
              remoteIsms.derived,
              `Hybrid hook/ISM (${node.type}) on warp router ${warpRouter}`,
              chainLookup,
            ),
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
      if (
        (key === 'validators' || key === 'blacklistedIds') &&
        Array.isArray(config[key])
      ) {
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
