import {
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

const MAX_OPERATIONS = 1;
const MAX_ROOT_FIELDS = 10;
const MAX_FIELD_COUNT = 250;
const MAX_ALIASES = 10;
const MAX_DEPTH = 6;

type QueryStats = {
  aliases: number;
  depth: number;
  fields: number;
  rootFields: number;
};

export const scraperProxyValidationRule: ValidationRule = (
  context: ValidationContext,
) => ({
  Document(documentNode: DocumentNode) {
    validateDocument(context, documentNode);
  },
});

function validateDocument(
  context: ValidationContext,
  documentNode: DocumentNode,
): void {
  const operations = documentNode.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length > MAX_OPERATIONS) {
    context.reportError(
      new GraphQLError(
        `Only ${MAX_OPERATIONS} operation per request is allowed`,
      ),
    );
    return;
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of documentNode.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  for (const operation of operations) {
    if (operation.operation !== 'query') {
      context.reportError(
        new GraphQLError('Only query operations are allowed'),
      );
      continue;
    }

    const stats = collectQueryStats(operation.selectionSet, fragments);
    reportBudgetError(
      context,
      stats.rootFields,
      MAX_ROOT_FIELDS,
      'root fields',
    );
    reportBudgetError(context, stats.fields, MAX_FIELD_COUNT, 'fields');
    reportBudgetError(context, stats.aliases, MAX_ALIASES, 'aliases');
    reportBudgetError(context, stats.depth, MAX_DEPTH, 'depth');
  }
}

function collectQueryStats(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
): QueryStats {
  const stats: QueryStats = {
    aliases: 0,
    depth: 0,
    fields: 0,
    rootFields: 0,
  };
  collectSelectionSetStats(selectionSet, fragments, stats, 0, true, new Set());
  return stats;
}

function collectSelectionSetStats(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  stats: QueryStats,
  depth: number,
  isRoot: boolean,
  visitedFragments: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    collectSelectionStats(
      selection,
      fragments,
      stats,
      depth,
      isRoot,
      visitedFragments,
    );
  }
}

function collectSelectionStats(
  selection: SelectionNode,
  fragments: Map<string, FragmentDefinitionNode>,
  stats: QueryStats,
  depth: number,
  isRoot: boolean,
  visitedFragments: Set<string>,
): void {
  if (selection.kind === Kind.FIELD) {
    const fieldName = selection.name.value;
    if (fieldName === '__schema' || fieldName === '__type') {
      stats.fields = MAX_FIELD_COUNT + 1;
      return;
    }

    stats.fields += 1;
    stats.depth = Math.max(stats.depth, depth + 1);
    if (selection.alias) stats.aliases += 1;
    if (isRoot) stats.rootFields += 1;
    if (selection.selectionSet) {
      collectSelectionSetStats(
        selection.selectionSet,
        fragments,
        stats,
        depth + 1,
        false,
        visitedFragments,
      );
    }
    return;
  }

  if (selection.kind === Kind.INLINE_FRAGMENT) {
    collectSelectionSetStats(
      selection.selectionSet,
      fragments,
      stats,
      depth,
      isRoot,
      visitedFragments,
    );
    return;
  }

  const fragmentName = selection.name.value;
  if (visitedFragments.has(fragmentName)) return;

  const fragment = fragments.get(fragmentName);
  if (!fragment) return;

  visitedFragments.add(fragmentName);
  collectSelectionSetStats(
    fragment.selectionSet,
    fragments,
    stats,
    depth,
    isRoot,
    visitedFragments,
  );
  visitedFragments.delete(fragmentName);
}

function reportBudgetError(
  context: ValidationContext,
  actual: number,
  max: number,
  label: string,
): void {
  if (actual > max) {
    context.reportError(
      new GraphQLError(`GraphQL query ${label} exceeds maximum of ${max}`),
    );
  }
}
