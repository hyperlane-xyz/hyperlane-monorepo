import {
  HeaderMap,
  type ApolloServerPlugin,
  type GraphQLResponse,
} from '@apollo/server';
import { createHash } from 'node:crypto';
import { type OperationDefinitionNode, valueFromASTUntyped } from 'graphql';

import {
  cacheControlHeader,
  clampCacheTtl,
  DEFAULT_CACHE_TTL_SECONDS,
} from './cache-config.js';

const MAX_CACHE_ENTRIES = 1000;
const MAX_CACHE_ENTRY_BYTES = 1_000_000;

type CacheEntry = {
  body: string;
  expiresAt: number;
};

type CacheDirective = {
  refresh: boolean;
  ttlSeconds: number;
};

const cache = new Map<string, CacheEntry>();

export function scraperDbCachePlugin(): ApolloServerPlugin {
  return {
    async requestDidStart() {
      let cacheDirective: CacheDirective | null = null;
      let cacheKey: string | null = null;

      return {
        async responseForOperation(requestContext) {
          cacheDirective = getCacheDirective(requestContext.operation);
          if (!cacheDirective) {
            return null;
          }

          cacheKey = buildCacheKey({
            operationName: requestContext.operationName,
            query: requestContext.source,
            variables: requestContext.request.variables ?? {},
          });

          if (cacheDirective.refresh) {
            cache.delete(cacheKey);
            return null;
          }

          const cached = cache.get(cacheKey);
          if (!cached) {
            return null;
          }

          if (cached.expiresAt <= Date.now()) {
            cache.delete(cacheKey);
            return null;
          }

          cache.delete(cacheKey);
          cache.set(cacheKey, cached);
          return responseFromCache(cached);
        },
        async willSendResponse(requestContext) {
          if (!cacheDirective) {
            return;
          }

          requestContext.response.http.headers.set(
            'cache-control',
            cacheControlHeader(cacheDirective.ttlSeconds),
          );

          if (
            !cacheKey ||
            requestContext.response.body.kind !== 'single' ||
            requestContext.response.body.singleResult.errors?.length
          ) {
            return;
          }

          const body = JSON.stringify(
            requestContext.response.body.singleResult,
          );
          if (Buffer.byteLength(body) > MAX_CACHE_ENTRY_BYTES) {
            return;
          }

          cache.set(cacheKey, {
            body,
            expiresAt: Date.now() + cacheDirective.ttlSeconds * 1000,
          });
          evictOldestEntries();
        },
      };
    },
  };
}

function responseFromCache(entry: CacheEntry): GraphQLResponse {
  const headers = new HeaderMap();
  headers.set('cache-control', cacheControlHeader(secondsUntilEntry(entry)));
  return {
    http: { headers },
    body: {
      kind: 'single',
      singleResult: JSON.parse(entry.body) as Record<string, unknown>,
    },
  };
}

function getCacheDirective(
  operation: OperationDefinitionNode,
): CacheDirective | null {
  if (operation.operation !== 'query') {
    return null;
  }

  const directive = operation.directives?.find(
    (item) => item.name.value === 'cached',
  );
  if (!directive) {
    return null;
  }

  const args = new Map(
    directive.arguments?.map((argument) => [
      argument.name.value,
      valueFromASTUntyped(argument.value),
    ]),
  );
  const ttlValue = args.get('ttl');
  const ttlSeconds =
    typeof ttlValue === 'number'
      ? clampCacheTtl(ttlValue)
      : DEFAULT_CACHE_TTL_SECONDS;

  return {
    refresh: args.get('refresh') === true,
    ttlSeconds,
  };
}

function buildCacheKey(input: {
  operationName: string | null;
  query: string;
  variables: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(input.operationName ?? '')
    .update('\0')
    .update(input.query)
    .update('\0')
    .update(stableStringify(input.variables))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function secondsUntilEntry(entry: CacheEntry): number {
  return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
}

function evictOldestEntries(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) {
      return;
    }
    cache.delete(oldest);
  }
}
