import {
  HeaderMap,
  type ApolloServerPlugin,
  type GraphQLResponse,
} from '@apollo/server';
import { createHash } from 'node:crypto';
import { parse, print, visit, type DocumentNode } from 'graphql';

import {
  cacheControlHeader,
  cacheDirective,
  type CacheDirective,
} from './cache-config.js';
import { stripUnusedVariableDefinitions } from './request-compatibility.js';

const MAX_ENTRIES = 1_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 16_000_000;
type Entry = { body: string; bytes: number; expires: number };

export function scraperDbCachePlugin(): ApolloServerPlugin {
  const cache = new Map<string, Entry>();
  let cacheBytes = 0;
  const remove = (key: string): void => {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    cacheBytes -= entry.bytes;
  };
  return {
    async requestDidStart() {
      let directive: CacheDirective | null = null;
      let hit = false;
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
            context.document,
            context.request.variables ?? {},
          );
          if (directive.refresh) {
            remove(key);
            return null;
          }
          const entry = cache.get(key);
          if (!entry || entry.expires <= Date.now()) {
            if (entry) remove(key);
            return null;
          }
          cache.delete(key);
          cache.set(key, entry);
          hit = true;
          return cachedResponse(entry);
        },
        async willSendResponse(context) {
          if (!directive || hit) return;
          if (
            !key ||
            context.response.body.kind !== 'single' ||
            context.response.body.singleResult.errors?.length
          ) {
            context.response.http.headers.set('cache-control', 'no-store');
            return;
          }
          context.response.http.headers.set(
            'cache-control',
            cacheControlHeader(directive.ttl),
          );
          if (directive.ttl === 0) {
            context.response.http.headers.set('cache-control', 'no-store');
            return;
          }
          const body = JSON.stringify(context.response.body.singleResult);
          const bytes = Buffer.byteLength(body);
          if (bytes > MAX_ENTRY_BYTES) return;
          remove(key);
          cache.set(key, {
            body,
            bytes,
            expires: Date.now() + directive.ttl * 1_000,
          });
          cacheBytes += bytes;
          while (cache.size > MAX_ENTRIES || cacheBytes > MAX_TOTAL_BYTES) {
            const oldest = cache.keys().next().value;
            if (!oldest) break;
            remove(oldest);
          }
        },
      };
    },
  };
}

function cacheKey(
  operation: string | null,
  document: DocumentNode,
  variables: Record<string, unknown>,
): string {
  const query = stripUnusedVariableDefinitions(
    print(
      visit(document, {
        Directive: (node) => (node.name.value === 'cached' ? null : undefined),
      }),
    ),
  );
  const usedVariables = new Set<string>();
  visit(parse(query), {
    Variable: ({ name }) => {
      usedVariables.add(name.value);
    },
  });
  const dataVariables = Object.fromEntries(
    Object.entries(variables).filter(([name]) => usedVariables.has(name)),
  );
  return createHash('sha256')
    .update(operation ?? '')
    .update('\0')
    .update(query)
    .update('\0')
    .update(stableJson(dataVariables))
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
      singleResult: parseCachedBody(entry.body),
    },
    http: { headers },
  };
}

function parseCachedBody(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value)) {
    throw new Error('Invalid cached GraphQL response');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
