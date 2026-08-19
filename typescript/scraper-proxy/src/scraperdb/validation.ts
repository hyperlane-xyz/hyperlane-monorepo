import {
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

const LIMITS = { rootFields: 10, fields: 250, aliases: 10, depth: 6 } as const;
type Stat = keyof typeof LIMITS;
type Stats = Record<Stat, number>;

export const scraperProxyValidationRule: ValidationRule = (context) => ({
  Document: (document) => validate(context, document),
});

function validate(context: ValidationContext, document: DocumentNode): void {
  const operations = document.definitions.filter(
    (node): node is OperationDefinitionNode =>
      node.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length > 1) {
    context.reportError(
      new GraphQLError('Only 1 operation per request is allowed'),
    );
    return;
  }
  const fragments = new Map(
    document.definitions
      .filter(
        (node): node is FragmentDefinitionNode =>
          node.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((node) => [node.name.value, node]),
  );
  for (const operation of operations) {
    if (operation.operation !== 'query') {
      context.reportError(
        new GraphQLError('Only query operations are allowed'),
      );
      continue;
    }
    const stats: Stats = { aliases: 0, depth: 0, fields: 0, rootFields: 0 };
    walk(operation.selectionSet, fragments, stats, 0, true, new Set());
    for (const [name, max] of Object.entries(LIMITS) as [Stat, number][]) {
      if (stats[name] > max) {
        const label = name === 'rootFields' ? 'root fields' : name;
        context.reportError(
          new GraphQLError(`GraphQL query ${label} exceeds maximum of ${max}`),
        );
      }
    }
  }
}

function walk(
  set: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  stats: Stats,
  depth: number,
  root: boolean,
  visited: Set<string>,
): void {
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      if (
        selection.name.value === '__schema' ||
        selection.name.value === '__type'
      ) {
        stats.fields = LIMITS.fields + 1;
        continue;
      }
      stats.fields++;
      stats.depth = Math.max(stats.depth, depth + 1);
      if (selection.alias) stats.aliases++;
      if (root) stats.rootFields++;
      if (selection.selectionSet) {
        walk(
          selection.selectionSet,
          fragments,
          stats,
          depth + 1,
          false,
          visited,
        );
      }
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      walk(selection.selectionSet, fragments, stats, depth, root, visited);
      continue;
    }
    const name = selection.name.value;
    const fragment = fragments.get(name);
    if (!fragment || visited.has(name)) continue;
    visited.add(name);
    walk(fragment.selectionSet, fragments, stats, depth, root, visited);
    visited.delete(name);
  }
}
