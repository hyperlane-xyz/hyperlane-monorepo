import {
  cacheControlHeader,
  clampCacheTtl,
  DEFAULT_CACHE_TTL_SECONDS,
} from './cache-config.js';

type Payload = { query?: unknown };

export function normalizeGraphqlRequestBody(body: unknown): void {
  (Array.isArray(body) ? body : [body]).forEach((payload) => {
    if (isPayload(payload) && typeof payload.query === 'string') {
      payload.query = stripUnusedVariableDefinitions(payload.query);
    }
  });
}

export function stripUnusedVariableDefinitions(query: string): string {
  return query.replace(
    /\b(query|mutation|subscription)(\s+[_A-Za-z][_0-9A-Za-z]*)?\s*\(([^)]*)\)/g,
    (
      match,
      operation: string,
      name = '',
      definitions: string,
      offset: number,
      source: string,
    ) => {
      const used = new Set(
        [
          ...source
            .slice(offset + match.length)
            .matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)/g),
        ].map(([, variable]) => variable),
      );
      const kept = definitions
        .split(',')
        .map((definition) => definition.trim())
        .filter((definition) => {
          const variable = definition.match(/^\$([_A-Za-z][_0-9A-Za-z]*)/)?.[1];
          return !variable || used.has(variable);
        });
      return kept.length
        ? `${operation}${name} (${kept.join(', ')})`
        : `${operation}${name}`;
    },
  );
}

export function cacheControlHeaderForGraphqlRequestBody(
  body: unknown,
): string | null {
  if (Array.isArray(body) || !isPayload(body) || typeof body.query !== 'string')
    return null;
  const directive = body.query.match(/@cached(?:\(([^)]*)\))?/);
  if (!directive) return null;
  const ttl = directive[1]?.match(/\bttl\s*:\s*(\d+)/)?.[1];
  return cacheControlHeader(
    ttl ? clampCacheTtl(Number(ttl)) : DEFAULT_CACHE_TTL_SECONDS,
  );
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && 'query' in value;
}
