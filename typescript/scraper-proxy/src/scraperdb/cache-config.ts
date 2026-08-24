import {
  OperationTypeNode,
  type OperationDefinitionNode,
  valueFromASTUntyped,
} from 'graphql';

export const DEFAULT_CACHE_TTL_SECONDS = 60;
export const MAX_CACHE_TTL_SECONDS = 300;
export type CacheDirective = { refresh: boolean; ttl: number };

export function clampCacheTtl(ttlSeconds: number): number {
  return Math.min(Math.max(ttlSeconds, 0), MAX_CACHE_TTL_SECONDS);
}

export function cacheControlHeader(ttlSeconds: number): string {
  return `max-age=${clampCacheTtl(ttlSeconds)}, public`;
}

export function cacheDirective(
  operation: OperationDefinitionNode,
  variables?: Record<string, unknown>,
): CacheDirective | null {
  if (operation.operation !== OperationTypeNode.QUERY) return null;
  const node = operation.directives?.find(
    ({ name }) => name.value === 'cached',
  );
  if (!node) return null;
  const args = Object.fromEntries(
    node.arguments?.map(({ name, value }) => [
      name.value,
      valueFromASTUntyped(value, variables),
    ]) ?? [],
  );
  return {
    refresh: args.refresh === true,
    ttl:
      typeof args.ttl === 'number'
        ? clampCacheTtl(args.ttl)
        : DEFAULT_CACHE_TTL_SECONDS,
  };
}
