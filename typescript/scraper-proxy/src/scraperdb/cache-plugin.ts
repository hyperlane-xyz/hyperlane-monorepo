import {
  HeaderMap,
  type ApolloServerPlugin,
  type GraphQLResponse,
} from '@apollo/server';
import { createHash } from 'node:crypto';

import {
  cacheControlHeader,
  cacheDirective,
  type CacheDirective,
} from './cache-config.js';

const MAX_ENTRIES = 1_000;
const MAX_BYTES = 1_000_000;
type Entry = { body: string; expires: number };
const cache = new Map<string, Entry>();

export function scraperDbCachePlugin(): ApolloServerPlugin {
  return {
    async requestDidStart() {
      let directive: CacheDirective | null = null;
      let key: string | null = null;
      return {
        async responseForOperation(context) {
          directive = cacheDirective(
            context.operation,
            context.request.variables,
          );
          if (!directive) return null;
          key = cacheKey(
            context.operationName,
            context.source,
            context.request.variables ?? {},
          );
          if (directive.refresh) {
            cache.delete(key);
            return null;
          }
          const entry = cache.get(key);
          if (!entry || entry.expires <= Date.now()) {
            if (entry) cache.delete(key);
            return null;
          }
          cache.delete(key);
          cache.set(key, entry);
          return cachedResponse(entry);
        },
        async willSendResponse(context) {
          if (!directive) return;
          context.response.http.headers.set(
            'cache-control',
            cacheControlHeader(directive.ttl),
          );
          if (
            !key ||
            context.response.body.kind !== 'single' ||
            context.response.body.singleResult.errors?.length
          ) {
            return;
          }
          const body = JSON.stringify(context.response.body.singleResult);
          if (Buffer.byteLength(body) > MAX_BYTES) return;
          cache.set(key, { body, expires: Date.now() + directive.ttl * 1_000 });
          while (cache.size > MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (!oldest) break;
            cache.delete(oldest);
          }
        },
      };
    },
  };
}

function cacheKey(
  operation: string | null,
  query: string,
  variables: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(operation ?? '')
    .update('\0')
    .update(query)
    .update('\0')
    .update(stableJson(variables))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function cachedResponse(entry: Entry): GraphQLResponse {
  const headers = new HeaderMap();
  headers.set(
    'cache-control',
    cacheControlHeader(
      Math.max(0, Math.ceil((entry.expires - Date.now()) / 1_000)),
    ),
  );
  return {
    body: {
      kind: 'single',
      singleResult: JSON.parse(entry.body) as Record<string, unknown>,
    },
    http: { headers },
  };
}
