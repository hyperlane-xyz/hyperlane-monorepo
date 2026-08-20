import { type DocumentNode, Kind, parse, print, visit } from 'graphql';

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

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && 'query' in value;
}
