import { ChainName, OnchainHookType } from '@hyperlane-xyz/sdk';
import { isMissingSelectorCallException } from '@hyperlane-xyz/sdk/utils/contract';
import {
  Address,
  assert,
  concurrentMap,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { isFixedVersion } from './plan.js';
import type { ChainReader } from './reader.js';
import {
  ChainDomain,
  ChainState,
  HookClassification,
  HookClassificationKind,
  MappedRoute,
  SkipReason,
} from './types.js';

export interface ReadChainStateArgs {
  chain: ChainName;
  originDomainId: number;
  mailbox: Address;
  factory: Address;
  registryAggregationHook?: Address;
  supportedDomains: ChainDomain[];
  registryDomainIds: number[];
  reader: ChainReader;
  concurrency: number;
}

export type ReadChainStateResult =
  | { state: ChainState }
  | { skip: SkipReason; detail: string };

async function classifyHook(
  reader: ChainReader,
  hook: Address,
): Promise<HookClassification> {
  let hookType: number;
  try {
    hookType = await reader.hookType(hook);
  } catch (error: unknown) {
    if (isMissingSelectorCallException(error)) {
      return { kind: HookClassificationKind.Unknown };
    }
    throw error;
  }
  if (hookType !== OnchainHookType.AGGREGATION) {
    return { kind: HookClassificationKind.Other, hookType };
  }
  const [children, version] = await Promise.all([
    reader.aggregationChildren(hook),
    reader.packageVersion(hook),
  ]);
  return {
    kind: HookClassificationKind.Aggregation,
    aggregator: { address: hook, children, version },
  };
}

// Only domains of supported chains are in scope. Mappings outside that
// universe are never changed; they are only counted for the report.
export async function readChainState(
  args: ReadChainStateArgs,
): Promise<ReadChainStateResult> {
  const { chain, originDomainId, mailbox, reader, concurrency } = args;

  const routingHook = await reader.defaultHook(mailbox);
  if (isZeroishAddress(routingHook)) {
    return {
      skip: SkipReason.DefaultHookNotFallbackRouting,
      detail: `mailbox ${mailbox} on ${chain} has no default hook`,
    };
  }
  const defaultHookType = await reader.hookType(routingHook);
  if (defaultHookType !== OnchainHookType.FALLBACK_ROUTING) {
    return {
      skip: SkipReason.DefaultHookNotFallbackRouting,
      detail: `default hook ${routingHook} on ${chain} has hook type ${defaultHookType}`,
    };
  }

  const [routingOwner, routingFallback, factoryVersion] = await Promise.all([
    reader.routingOwner(routingHook),
    reader.routingFallback(routingHook),
    reader.packageVersion(args.factory),
  ]);

  const universe = args.supportedDomains.filter(
    (domain) => domain.domainId !== originDomainId,
  );
  const universeIds = new Set(universe.map((domain) => domain.domainId));
  const probed = await concurrentMap(concurrency, universe, async (domain) => ({
    domain,
    hook: await reader.routedHook(routingHook, domain.domainId),
  }));
  const routes: MappedRoute[] = [];
  const unmapped: ChainDomain[] = [];
  for (const { domain, hook } of probed) {
    if (isZeroishAddress(hook)) unmapped.push(domain);
    else routes.push({ domain, hook });
  }

  const ignoredCandidates = [...new Set(args.registryDomainIds)].filter(
    (domainId) => domainId !== originDomainId && !universeIds.has(domainId),
  );
  const ignoredHooks = (
    await concurrentMap(concurrency, ignoredCandidates, (domainId) =>
      reader.routedHook(routingHook, domainId),
    )
  ).filter((hook) => !isZeroishAddress(hook));

  const hooksToClassify = new Map<string, Address>();
  for (const hook of [...routes.map((route) => route.hook), ...ignoredHooks]) {
    hooksToClassify.set(hook.toLowerCase(), hook);
  }
  if (args.registryAggregationHook) {
    hooksToClassify.set(
      args.registryAggregationHook.toLowerCase(),
      args.registryAggregationHook,
    );
  }
  const classifications = new Map<string, HookClassification>();
  await concurrentMap(
    concurrency,
    [...hooksToClassify],
    async ([key, hook]) => {
      classifications.set(key, await classifyHook(reader, hook));
    },
  );

  const aggregationRoutes = routes.filter(
    (route) =>
      classifications.get(route.hook.toLowerCase())?.kind ===
      HookClassificationKind.Aggregation,
  );
  if (aggregationRoutes.length === 0) {
    return {
      skip: SkipReason.NoAggregationRoutes,
      detail: `no supported domain on ${chain} routes to an aggregation hook`,
    };
  }

  let registryAggregationHook: ChainState['registryAggregationHook'];
  if (args.registryAggregationHook) {
    const classification = classifications.get(
      args.registryAggregationHook.toLowerCase(),
    );
    assert(
      classification?.kind === HookClassificationKind.Aggregation,
      `Registry aggregationHook ${args.registryAggregationHook} on ${chain} is not an aggregation hook`,
    );
    registryAggregationHook = classification.aggregator;
  }

  let ignoredLegacyAggregator = 0;
  for (const hook of ignoredHooks) {
    const classification = classifications.get(hook.toLowerCase());
    if (
      classification?.kind === HookClassificationKind.Aggregation &&
      !isFixedVersion(classification.aggregator.version)
    ) {
      ignoredLegacyAggregator++;
    }
  }

  return {
    state: {
      chain,
      mailbox,
      routingHook,
      routingOwner,
      routingFallback,
      factory: { address: args.factory, version: factoryVersion },
      routes,
      unmapped,
      classifications,
      ignored: {
        mapped: ignoredHooks.length,
        legacyAggregator: ignoredLegacyAggregator,
      },
      registryAggregationHook,
    },
  };
}
