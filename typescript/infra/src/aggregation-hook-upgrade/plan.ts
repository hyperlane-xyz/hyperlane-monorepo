import { ethers } from 'ethers';

import {
  ChainName,
  ERC20_FEE_AGGREGATION_HOOK_VERSION,
  getTxConfigBatchSize,
} from '@hyperlane-xyz/sdk';
import { isValidContractVersion } from '@hyperlane-xyz/sdk/utils/contract';
import { Address, assert, chunk, eqAddress } from '@hyperlane-xyz/utils';

import {
  AggregatorSet,
  ChainPlan,
  ChainState,
  HookClassification,
  HookClassificationKind,
  NonAggregationRoute,
  PlannedRoute,
  RouteConfig,
  UpgradePhase,
} from './types.js';

// Not `>= 11.0.0`: hooks built before the fix also report 11.0.0.
export function isFixedVersion(version: string): boolean {
  return isValidContractVersion(version, ERC20_FEE_AGGREGATION_HOOK_VERSION);
}

// CREATE2 salts depend on child order, so the order is part of the identity.
export function aggregatorKey(children: Address[]): string {
  return children.map((child) => child.toLowerCase()).join(',');
}

function classificationFor(
  state: ChainState,
  hook: Address,
): HookClassification {
  const classification = state.classifications.get(hook.toLowerCase());
  assert(
    classification,
    `Missing classification for hook ${hook} on ${state.chain}`,
  );
  return classification;
}

export function planChain(state: ChainState, phase: UpgradePhase): ChainPlan {
  const needsFactory = !isFixedVersion(state.factory.version);
  const sets = new Map<string, AggregatorSet>();
  const migrations: PlannedRoute[] = [];
  const nonAggregation: NonAggregationRoute[] = [];
  let fixedRoutes = 0;

  const addToSet = (children: Address[], replaces: Address): string => {
    const key = aggregatorKey(children);
    const existing = sets.get(key);
    if (!existing) {
      sets.set(key, { key, children, replaces: [replaces] });
    } else if (!existing.replaces.some((old) => eqAddress(old, replaces))) {
      existing.replaces.push(replaces);
    }
    return key;
  };

  for (const route of state.routes) {
    const classification = classificationFor(state, route.hook);
    if (classification.kind === HookClassificationKind.Aggregation) {
      const { aggregator } = classification;
      if (isFixedVersion(aggregator.version)) {
        fixedRoutes++;
        continue;
      }
      const key = addToSet(aggregator.children, aggregator.address);
      migrations.push({ domain: route.domain, from: route.hook, key });
    } else if (classification.kind === HookClassificationKind.Other) {
      nonAggregation.push({
        domain: route.domain,
        hook: route.hook,
        hookType: classification.hookType,
      });
    } else {
      nonAggregation.push({ domain: route.domain, hook: route.hook });
    }
  }

  let registryAggregationKey: string | undefined;
  const registryHook = state.registryAggregationHook;
  if (registryHook && !isFixedVersion(registryHook.version)) {
    registryAggregationKey = addToSet(
      registryHook.children,
      registryHook.address,
    );
  }

  const routingConverged = !needsFactory && migrations.length === 0;
  const upToDate =
    phase === UpgradePhase.Prod
      ? routingConverged && registryAggregationKey === undefined
      : routingConverged;
  return {
    needsFactory,
    sets: upToDate ? [] : [...sets.values()],
    migrations,
    registryAggregationKey,
    fixedRoutes,
    nonAggregation,
    unmapped: state.unmapped,
    upToDate,
  };
}

export function chunkRoutes(
  chain: ChainName,
  routes: RouteConfig[],
): RouteConfig[][] {
  return chunk(routes, getTxConfigBatchSize(chain));
}

function sortRoutes(routes: RouteConfig[]): RouteConfig[] {
  return [...routes].sort((a, b) => a.destination - b.destination);
}

export function buildProdTargets(
  plan: ChainPlan,
  aggregatorByKey: Map<string, Address>,
): RouteConfig[] {
  return sortRoutes(
    plan.migrations.map((route) => {
      const hook = aggregatorByKey.get(route.key);
      assert(
        hook,
        `Missing new aggregator for domain ${route.domain.domainId} (${route.domain.chain})`,
      );
      return { destination: route.domain.domainId, hook };
    }),
  );
}

export function buildShadowTargets(
  state: ChainState,
  plan: ChainPlan,
  aggregatorByKey: Map<string, Address>,
): RouteConfig[] {
  const keyByDomain = new Map(
    plan.migrations.map((route) => [route.domain.domainId, route.key]),
  );
  const mapped = state.routes.map((route) => {
    const key = keyByDomain.get(route.domain.domainId);
    if (key === undefined) {
      return { destination: route.domain.domainId, hook: route.hook };
    }
    const hook = aggregatorByKey.get(key);
    assert(
      hook,
      `Missing new aggregator for domain ${route.domain.domainId} (${route.domain.chain})`,
    );
    return { destination: route.domain.domainId, hook };
  });
  // The 20-byte setHooks sentinel: clears the route so the fallback hook handles it.
  const unmapped = state.unmapped.map((domain) => ({
    destination: domain.domainId,
    hook: ethers.constants.AddressZero,
  }));
  return sortRoutes([...mapped, ...unmapped]);
}

export function diffRoutes(
  current: Map<number, Address>,
  targets: RouteConfig[],
): RouteConfig[] {
  return targets.filter((target) => {
    const actual = current.get(target.destination);
    return actual === undefined || !eqAddress(actual, target.hook);
  });
}

export function assertChildrenPreserved(
  expected: Address[],
  actual: Address[],
  label: string,
): void {
  assert(
    expected.length === actual.length &&
      expected.every((child, index) => eqAddress(child, actual[index])),
    `${label} children differ from the replaced aggregator (order-sensitive)`,
  );
}
