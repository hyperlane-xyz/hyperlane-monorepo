import { type DocumentNode, Kind, parse, print, visit } from 'graphql';

// Cache only pure query-text normalization, independently of response freshness.
// At most 1 MiB of UTF-16 string content (excluding Map/object overhead).
const MAX_NORMALIZED_QUERIES = 64;
const MAX_QUERY_PAIR_LENGTH = 8_192;
const normalizedQueries = new Map<string, string>();

type Payload = {
  operationName?: unknown;
  query?: unknown;
  variables?: unknown;
};

export function normalizeGraphqlRequestBody(body: unknown): void {
  for (const payload of Array.isArray(body) ? body : [body]) {
    if (isPayload(payload) && typeof payload.query === 'string') {
      payload.query = stripUnusedVariableDefinitions(payload.query);
    }
  }
}

export function stripUnusedVariableDefinitions(query: string): string {
  const cached = normalizedQueries.get(query);
  if (cached !== undefined) {
    normalizedQueries.delete(query);
    normalizedQueries.set(query, cached);
    return cached;
  }
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch {
    return query;
  }
  const used = new Set<string>();
  visit(document, {
    Variable: ({ name }, _key, parent) => {
      if (
        !parent ||
        !('kind' in parent) ||
        parent.kind !== Kind.VARIABLE_DEFINITION
      )
        used.add(name.value);
    },
  });
  const normalized = print(
    visit(document, {
      OperationDefinition: (node) => ({
        ...node,
        variableDefinitions: node.variableDefinitions?.filter(({ variable }) =>
          used.has(variable.name.value),
        ),
      }),
    }),
  );
  if (query.length + normalized.length <= MAX_QUERY_PAIR_LENGTH) {
    normalizedQueries.set(query, normalized);
    if (normalizedQueries.size > MAX_NORMALIZED_QUERIES) {
      const oldest = normalizedQueries.keys().next().value;
      if (oldest !== undefined) normalizedQueries.delete(oldest);
    }
  }
  return normalized;
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && 'query' in value;
}
