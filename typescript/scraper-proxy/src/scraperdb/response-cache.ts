import { createHash } from 'node:crypto';

import { assert } from '@hyperlane-xyz/utils/validation';
import {
  parse,
  print,
  visit,
  type DocumentNode,
  type OperationDefinitionNode,
} from 'graphql';

import {
  graphqlCacheInflightLoads,
  graphqlCacheLoadFailures,
  graphqlCacheRequests,
} from '../metrics.js';
import { cacheControlHeader, cacheDirective } from './cache-config.js';
import { stripUnusedVariableDefinitions } from './request-compatibility.js';

const MAX_ENTRIES = 1_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 16_000_000;

type Entry = { body: string; bytes: number; expires: number };
type CacheDocument = { query: string; usedVariables: ReadonlySet<string> };

export type PreparedCacheRequest = {
  key: string;
  refresh: boolean;
  ttl: number;
};

export type CachedGraphqlResponse = {
  body: string;
  ttl: number;
};

export type SharedGraphqlResponse = {
  body: string;
  cacheControl: string;
  statusCode: number;
};

type Flight = {
  promise: Promise<SharedGraphqlResponse | null>;
  refresh: boolean;
  resolve: (response: SharedGraphqlResponse | null) => void;
  settled: boolean;
};

export class GraphqlResponseCache {
  private readonly cache = new Map<string, Entry>();
  private readonly documents = new WeakMap<DocumentNode, CacheDocument>();
  private cacheBytes = 0;
  private readonly flights = new Map<string, Flight>();
  private readonly owners = new WeakMap<PreparedCacheRequest, Flight>();

  constructor(private readonly maxInflightLoads = 1_000) {}

  async acquire(
    request: PreparedCacheRequest,
  ): Promise<SharedGraphqlResponse | null> {
    const cached = this.read(request);
    if (cached) {
      graphqlCacheRequests.inc({ outcome: 'hit' });
      return {
        body: cached.body,
        cacheControl: cacheControlHeader(cached.ttl),
        statusCode: 200,
      };
    }
    const existing = this.flights.get(request.key);
    if (existing && (!request.refresh || existing.refresh)) {
      graphqlCacheRequests.inc({ outcome: 'coalesced' });
      return existing.promise;
    }
    if (this.flights.size >= this.maxInflightLoads && !existing) {
      graphqlCacheRequests.inc({ outcome: 'capacity_bypass' });
      return null;
    }
    let resolve: Flight['resolve'] = () => undefined;
    const promise = new Promise<SharedGraphqlResponse | null>(
      (resolveFlight) => {
        resolve = resolveFlight;
      },
    );
    const flight = {
      promise,
      refresh: request.refresh,
      resolve,
      settled: false,
    };
    // A refresh replaces the old owner even at capacity. The old request still
    // completes for its waiters, but cannot repopulate the refreshed key.
    this.flights.set(request.key, flight);
    this.owners.set(request, flight);
    if (!existing) graphqlCacheInflightLoads.inc();
    graphqlCacheRequests.inc({ outcome: 'miss' });
    return null;
  }

  complete(
    request: PreparedCacheRequest,
    response: SharedGraphqlResponse | null,
    cacheable: boolean,
  ): void {
    const flight = this.owners.get(request);
    if (!flight || flight.settled) return;
    if (!cacheable) graphqlCacheLoadFailures.inc();
    if (response && cacheable && this.flights.get(request.key) === flight) {
      this.write(request, response.body);
    }
    this.finish(request.key, flight, response);
  }

  abandon(request: PreparedCacheRequest): void {
    const flight = this.owners.get(request);
    if (!flight || flight.settled) return;
    graphqlCacheLoadFailures.inc();
    this.finish(request.key, flight, null);
  }

  private finish(
    key: string,
    flight: Flight,
    response: SharedGraphqlResponse | null,
  ): void {
    flight.settled = true;
    if (this.flights.get(key) === flight) {
      this.flights.delete(key);
      graphqlCacheInflightLoads.dec();
    }
    flight.resolve(response);
  }

  prepare(
    document: DocumentNode,
    operation: OperationDefinitionNode,
    operationName: string | null,
    variables: Record<string, unknown>,
  ): PreparedCacheRequest | null {
    const directive = cacheDirective(operation, variables);
    if (!directive) return null;
    let cachedDocument = this.documents.get(document);
    if (!cachedDocument) {
      cachedDocument = prepareCacheDocument(document);
      this.documents.set(document, cachedDocument);
    }
    return {
      key: cacheKey(operationName, cachedDocument, variables),
      refresh: directive.refresh,
      ttl: directive.ttl,
    };
  }

  read(request: PreparedCacheRequest): CachedGraphqlResponse | null {
    if (request.refresh) {
      this.remove(request.key);
      return null;
    }
    const entry = this.cache.get(request.key);
    if (!entry || entry.expires <= Date.now()) {
      if (entry) this.remove(request.key);
      return null;
    }
    this.cache.delete(request.key);
    this.cache.set(request.key, entry);
    return {
      body: entry.body,
      ttl: Math.max(0, Math.ceil((entry.expires - Date.now()) / 1_000)),
    };
  }

  write(request: PreparedCacheRequest, body: string): void {
    if (request.ttl === 0) return;
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_ENTRY_BYTES) return;
    this.remove(request.key);
    this.cache.set(request.key, {
      body,
      bytes,
      expires: Date.now() + request.ttl * 1_000,
    });
    this.cacheBytes += bytes;
    while (this.cache.size > MAX_ENTRIES || this.cacheBytes > MAX_TOTAL_BYTES) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  private remove(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
  }
}

function prepareCacheDocument(document: DocumentNode): CacheDocument {
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
  return { query, usedVariables };
}

function cacheKey(
  operation: string | null,
  { query, usedVariables }: CacheDocument,
  variables: Record<string, unknown>,
): string {
  const dataVariables = Object.fromEntries(
    Object.entries(variables).filter(([name]) => usedVariables.has(name)),
  );
  const serializedVariables = JSON.stringify(sortObjectKeys(dataVariables));
  assert(serializedVariables, 'Failed to serialize GraphQL variables');
  return createHash('sha256')
    .update(operation ?? '')
    .update('\0')
    .update(query)
    .update('\0')
    .update(serializedVariables)
    .digest('hex');
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
