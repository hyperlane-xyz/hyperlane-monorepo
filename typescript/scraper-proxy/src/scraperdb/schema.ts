import { OperationTypeNode, parse, print, visit } from 'graphql';

export function sanitizeScraperDbSchema(schema: string): string {
  const document = parse(`directive @cached(ttl: Int, refresh: Boolean) on QUERY

extend type query_root {
  message_view_aggregate(
    where: message_view_bool_exp
    order_by: [message_view_order_by!]
    limit: Int
    offset: Int
    distinct_on: [message_view_select_column!]
  ): message_view_aggregate!
}

type message_view_aggregate {
  aggregate: message_view_aggregate_fields
  nodes: [message_view!]!
}

type message_view_aggregate_fields {
  count(columns: [message_view_select_column!], distinct: Boolean): Int!
}

${schema}`);
  return print(
    visit(document, {
      EnumTypeDefinition: (node) =>
        node.name.value.startsWith('__') ? null : undefined,
      ObjectTypeDefinition: (node) =>
        node.name.value === 'subscription_root' ||
        node.name.value.startsWith('__')
          ? null
          : undefined,
      SchemaDefinition: (node) => ({
        ...node,
        operationTypes: node.operationTypes.filter(
          ({ operation }) => operation !== OperationTypeNode.SUBSCRIPTION,
        ),
      }),
    }),
  );
}
