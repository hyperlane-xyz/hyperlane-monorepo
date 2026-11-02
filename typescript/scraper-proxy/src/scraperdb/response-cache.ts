import { createHash } from 'node:crypto';

import { assert } from '@hyperlane-xyz/utils/validation';
import {
  getOperationAST,
  getVariableValues,
  parse,
  specifiedRules,
  validate,
  type GraphQLSchema,
  print,
  visit,
  type DocumentNode,
  type OperationDefinitionNode,
} from 'graphql';

import { cacheDirective } from './cache-config.js';
import { stripUnusedVariables } from './request-compatibility.js';
import {
  MAX_GRAPHQL_TOKENS,
  scraperProxyValidationRule,
} from './validation.js';

const MAX_PREPARED_DOCUMENTS = 256;
const MAX_PREPARED_DOCUMENT_BYTES = 8_192;
const VALIDATION_RULES = [...specifiedRules, scraperProxyValidationRule];
const MAX_ENTRIES = 1_000;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 16_000_000;

type Entry = { body: string; bytes: number; expires: number };
type CacheDocument = { query: string; usedVariables: ReadonlySet<string> };
type PreparedDocument = {
  operation: OperationDefinitionNode;
  cacheDocument: CacheDocument;
};

export type PreparedCacheRequest = {
  key: string;
  refresh: boolean;
  ttl: number;
};

export type CachedGraphqlResponse = {
  body: string;
  ttl: number;
};

export class GraphqlResponseCache {
  private readonly cache = new Map<string, Entry>();
  private cacheBytes = 0;
  private readonly documents = new WeakMap<
    GraphQLSchema,
    Map<string, PreparedDocument>
  >();

  prepare(schema: GraphQLSchema, body: unknown): PreparedCacheRequest | null {
    if (
      !isRecord(body) ||
      typeof body.query !== 'string' ||
      !body.query.includes('cached') ||
      (body.operationName != null && typeof body.operationName !== 'string')
    )
      return null;
    let variables: unknown = body.variables ?? {};
    try {
      if (typeof variables === 'string')
        variables = JSON.parse(variables) ?? {};
    } catch {
      // Mercurius owns error responses for invalid requests.
      return null;
    }
    if (!isRecord(variables)) return null;
    const operationName = body.operationName ?? null;
    const prepared = this.prepareDocument(schema, body.query, operationName);
    if (!prepared) return null;
    const { operation, cacheDocument } = prepared;
    if (
      getVariableValues(schema, operation.variableDefinitions ?? [], variables)
        .errors?.length
    )
      return null;
    const directive = cacheDirective(operation, variables);
    if (!directive) return null;
    return {
      key: cacheKey(operationName, cacheDocument, variables),
      refresh: directive.refresh,
      ttl: directive.ttl,
    };
  }

  private prepareDocument(
    schema: GraphQLSchema,
    query: string,
    operationName: string | null,
  ): PreparedDocument | null {
    const key = JSON.stringify([operationName, query]);
    const documents =
      this.documents.get(schema) ?? new Map<string, PreparedDocument>();
    const cached = documents.get(key);
    if (cached) {
      documents.delete(key);
      documents.set(key, cached);
      return cached;
    }
    let document: DocumentNode;
    try {
      document = stripUnusedVariables(
        parse(query, { maxTokens: MAX_GRAPHQL_TOKENS }),
      );
    } catch {
      return null;
    }
    if (validate(schema, document, VALIDATION_RULES).length) return null;
    const operation = getOperationAST(document, operationName);
    if (!operation || !cacheDirective(operation)) return null;
    const prepared = {
      operation,
      cacheDocument: prepareCacheDocument(document),
    };
    // Bound retained ASTs as well as response bodies. Large queries still work.
    if (Buffer.byteLength(key) <= MAX_PREPARED_DOCUMENT_BYTES) {
      this.documents.set(schema, documents);
      documents.set(key, prepared);
      if (documents.size > MAX_PREPARED_DOCUMENTS) {
        const oldest = documents.keys().next().value;
        if (oldest !== undefined) documents.delete(oldest);
      }
    }
    return prepared;
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
  const normalized = stripUnusedVariables(
    visit(document, {
      Directive: (node) => (node.name.value === 'cached' ? null : undefined),
    }),
  );
  const usedVariables = new Set<string>();
  visit(normalized, {
    Variable: ({ name }) => {
      usedVariables.add(name.value);
    },
  });
  return { query: print(normalized), usedVariables };
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
