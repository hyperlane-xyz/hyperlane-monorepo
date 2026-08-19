import {
  type DocumentNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  print,
  visit,
} from 'graphql';

import { cacheControlHeader, cacheDirective } from './cache-config.js';

type Payload = {
  operationName?: unknown;
  query?: unknown;
  variables?: unknown;
};

export function normalizeGraphqlRequestBody(body: unknown): void {
  (Array.isArray(body) ? body : [body]).forEach((payload) => {
    if (isPayload(payload) && typeof payload.query === 'string') {
      payload.query = stripUnusedVariableDefinitions(payload.query);
    }
  });
}

export function stripUnusedVariableDefinitions(query: string): string {
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
  return print(
    visit(document, {
      OperationDefinition: (node) => ({
        ...node,
        variableDefinitions: node.variableDefinitions?.filter(({ variable }) =>
          used.has(variable.name.value),
        ),
      }),
    }),
  );
}

export function cacheControlHeaderForGraphqlRequestBody(
  body: unknown,
): string | null {
  if (Array.isArray(body) || !isPayload(body) || typeof body.query !== 'string')
    return null;
  let document: DocumentNode;
  try {
    document = parse(body.query);
  } catch {
    return null;
  }
  const operation = document.definitions.find(
    (node): node is OperationDefinitionNode =>
      node.kind === Kind.OPERATION_DEFINITION &&
      (typeof body.operationName !== 'string' ||
        node.name?.value === body.operationName),
  );
  const directive = operation && cacheDirective(operation, variables(body));
  return directive ? cacheControlHeader(directive.ttl) : null;
}

function variables(payload: Payload): Record<string, unknown> | undefined {
  return payload.variables && typeof payload.variables === 'object'
    ? (payload.variables as Record<string, unknown>)
    : undefined;
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && 'query' in value;
}
