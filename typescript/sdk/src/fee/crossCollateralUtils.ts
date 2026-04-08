import { ChainName } from '../types.js';

import { DEFAULT_ROUTER_KEY } from './types.js';

export type CrossCollateralRoutersByDomain = Record<number, string[]>;

export function getConfiguredRoutingDestinations(
  feeContracts: Record<ChainName, unknown>,
  getDestinationDomain: (chainName: ChainName) => number,
): number[] {
  return Object.keys(feeContracts).map((chainName) =>
    getDestinationDomain(chainName),
  );
}

export function getConfiguredCrossCollateralRouters(
  feeContracts: Record<ChainName, Record<string, unknown>>,
  getDestinationDomain: (chainName: ChainName) => number,
): CrossCollateralRoutersByDomain {
  return Object.fromEntries(
    Object.entries(feeContracts).map(([chainName, routerFeeContracts]) => [
      getDestinationDomain(chainName),
      Object.keys(routerFeeContracts),
    ]),
  );
}

export function mergeCrossCollateralRouters(
  ...routerMaps: Array<CrossCollateralRoutersByDomain | undefined>
): CrossCollateralRoutersByDomain | undefined {
  const mergedRouters = new Map<number, Set<string>>();

  for (const routerMap of routerMaps) {
    if (!routerMap) continue;

    for (const [destination, routers] of Object.entries(routerMap)) {
      const destinationDomain = Number(destination);
      const mergedDestinationRouters =
        mergedRouters.get(destinationDomain) ?? new Set<string>();

      for (const router of routers) {
        mergedDestinationRouters.add(router);
      }

      mergedRouters.set(destinationDomain, mergedDestinationRouters);
    }
  }

  if (mergedRouters.size === 0) return undefined;

  return Object.fromEntries(
    [...mergedRouters.entries()].map(([destination, routers]) => [
      destination,
      [...routers],
    ]),
  );
}

export function getEffectiveCrossCollateralDestinations(
  routingDestinations?: number[],
  crossCollateralRouters?: CrossCollateralRoutersByDomain,
): number[] {
  const crossCollateralDestinations = Object.keys(
    crossCollateralRouters ?? {},
  ).map((domain) => Number(domain));

  return [
    ...new Set([
      ...(routingDestinations ?? []),
      ...crossCollateralDestinations,
    ]),
  ];
}

export function getCrossCollateralRouterKeys(
  destination: number,
  crossCollateralRouters?: CrossCollateralRoutersByDomain,
): string[] {
  return [
    ...new Set([
      DEFAULT_ROUTER_KEY,
      ...(crossCollateralRouters?.[destination] ?? []),
    ]),
  ];
}
