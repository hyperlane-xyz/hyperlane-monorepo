import { type DocumentNode, Kind, visit } from 'graphql';

export function stripUnusedVariables(document: DocumentNode): DocumentNode {
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
  return visit(document, {
    OperationDefinition: (node) => ({
      ...node,
      variableDefinitions: node.variableDefinitions?.filter(({ variable }) =>
        used.has(variable.name.value),
      ),
    }),
  });
}
