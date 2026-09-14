import {
  HeaderMap,
  type ApolloServerPlugin,
  type GraphQLResponse,
} from '@apollo/server';
import { cacheControlHeader } from './cache-config.js';
import {
  GraphqlResponseCache,
  type PreparedCacheRequest,
} from './response-cache.js';

type Entry = { body: string; ttl: number };

export function scraperDbCachePlugin(): ApolloServerPlugin {
  const cache = new GraphqlResponseCache();
  return {
    async requestDidStart() {
      let request: PreparedCacheRequest | null = null;
      let hit = false;
      return {
        async responseForOperation(context) {
          request = cache.prepare(
            context.document,
            context.operation,
            context.operationName,
            context.request.variables ?? {},
          );
          if (!request) return null;
          const entry = cache.read(request);
          if (!entry) return null;
          hit = true;
          return cachedResponse(entry);
        },
        async willSendResponse(context) {
          if (!request || hit) return;
          if (
            context.response.body.kind !== 'single' ||
            context.response.body.singleResult.errors?.length
          ) {
            context.response.http.headers.set('cache-control', 'no-store');
            return;
          }
          context.response.http.headers.set(
            'cache-control',
            cacheControlHeader(request.ttl),
          );
          if (request.ttl === 0) {
            context.response.http.headers.set('cache-control', 'no-store');
            return;
          }
          const body = JSON.stringify(context.response.body.singleResult);
          cache.write(request, body);
        },
      };
    },
  };
}

function cachedResponse(entry: Entry): GraphQLResponse {
  const headers = new HeaderMap();
  headers.set('cache-control', cacheControlHeader(entry.ttl));
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
