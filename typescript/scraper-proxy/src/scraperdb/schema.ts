export function sanitizeScraperDbSchema(schema: string): string {
  return `directive @cached(ttl: Int, refresh: Boolean) on QUERY

extend type query_root {
  message_view_aggregate(
    where: message_view_bool_exp
    order_by: [message_view_order_by!]
    limit: Int
    offset: Int
    distinct_on: [message_view_select_column!]
  ): message_view_aggregate!
}

extend type subscription_root {
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

${schema}`
    .replace(/\ntype __Directive \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\ntype __EnumValue \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\ntype __Field \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\ntype __InputValue \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\ntype __Schema \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\ntype __Type \{[\s\S]*?\n\}\n/g, '\n')
    .replace(/\nenum __TypeKind \{[\s\S]*?\n\}\n/g, '\n');
}
