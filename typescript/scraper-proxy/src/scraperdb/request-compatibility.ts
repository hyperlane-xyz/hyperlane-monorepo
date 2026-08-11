import {
  cacheControlHeader,
  clampCacheTtl,
  DEFAULT_CACHE_TTL_SECONDS,
} from './cache-config.js';

type GraphqlRequestPayload = {
  query?: unknown;
};

export function normalizeGraphqlRequestBody(body: unknown): void {
  if (Array.isArray(body)) {
    body.forEach(normalizeGraphqlPayload);
    return;
  }

  normalizeGraphqlPayload(body);
}

export function stripUnusedVariableDefinitions(query: string): string {
  return query.replace(
    /\b(query|mutation|subscription)(\s+[_A-Za-z][_0-9A-Za-z]*)?\s*\(([^)]*)\)/g,
    (
      match,
      operation: string,
      operationName = '',
      definitions: string,
      offset: number,
      source: string,
    ) => {
      const remainingOperation = source.slice(offset + match.length);
      const usedVariables = new Set(
        [...remainingOperation.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/g)].map(
          ([, name]) => name,
        ),
      );
      const keptDefinitions = definitions
        .split(',')
        .map((definition) => definition.trim())
        .filter((definition) => {
          const variableName = definition.match(
            /^\$([_A-Za-z][_0-9A-Za-z]*)/,
          )?.[1];
          return variableName ? usedVariables.has(variableName) : true;
        });

      if (keptDefinitions.length === 0) {
        return `${operation}${operationName}`;
      }

      return `${operation}${operationName} (${keptDefinitions.join(', ')})`;
    },
  );
}

export function cacheControlHeaderForGraphqlRequestBody(
  body: unknown,
): string | null {
  if (Array.isArray(body)) {
    return null;
  }

  if (!isGraphqlRequestPayload(body) || typeof body.query !== 'string') {
    return null;
  }

  const ttl = cacheTtlFromQuery(body.query);
  return ttl === null ? null : cacheControlHeader(ttl);
}

function normalizeGraphqlPayload(payload: unknown): void {
  if (!isGraphqlRequestPayload(payload) || typeof payload.query !== 'string') {
    return;
  }

  payload.query = stripUnusedVariableDefinitions(payload.query);
}

function isGraphqlRequestPayload(
  payload: unknown,
): payload is GraphqlRequestPayload {
  return typeof payload === 'object' && payload !== null && 'query' in payload;
}

function cacheTtlFromQuery(query: string): number | null {
  const cachedDirective = query.match(/@cached(?:\(([^)]*)\))?/);
  if (!cachedDirective) {
    return null;
  }

  const ttlMatch = cachedDirective[1]?.match(/\bttl\s*:\s*(\d+)/);
  if (!ttlMatch) {
    return DEFAULT_CACHE_TTL_SECONDS;
  }

  return clampCacheTtl(Number(ttlMatch[1]));
}
