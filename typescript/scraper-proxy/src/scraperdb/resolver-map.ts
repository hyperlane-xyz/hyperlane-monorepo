import type { FieldNode, GraphQLResolveInfo, SelectionNode } from 'graphql';

import { ScraperDbService } from './scraperdb.service.js';
import { scalarResolvers } from './scalars.js';
import type { SelectArgs } from './sql.js';
import type { TableName } from './tables.js';

type Row = Record<string, unknown>;
type ResolverMap = Record<string, unknown>;

export function buildResolvers(scraperDb: ScraperDbService): ResolverMap {
  return {
    ...scalarResolvers,
    query_root: {
      domain: selectResolver(scraperDb, 'domain'),
      domain_by_pk: byPkResolver(scraperDb, 'domain'),
      message_view: selectResolver(scraperDb, 'message_view'),
      message_view_aggregate: (_parent: unknown, args: SelectArgs) =>
        scraperDb.aggregate('message_view', args),
      raw_message_dispatch: selectResolver(scraperDb, 'raw_message_dispatch'),
      raw_message_dispatch_by_pk: byPkResolver(
        scraperDb,
        'raw_message_dispatch',
      ),
    },
    subscription_root: {
      domain: subscriptionResolver(scraperDb, 'domain'),
      domain_by_pk: byPkSubscriptionResolver(scraperDb, 'domain'),
      domain_stream: subscriptionResolver(scraperDb, 'domain'),
      message_view: subscriptionResolver(scraperDb, 'message_view'),
      message_view_aggregate: aggregateSubscriptionResolver(
        scraperDb,
        'message_view',
      ),
      message_view_stream: subscriptionResolver(scraperDb, 'message_view'),
      raw_message_dispatch: subscriptionResolver(
        scraperDb,
        'raw_message_dispatch',
      ),
      raw_message_dispatch_by_pk: byPkSubscriptionResolver(
        scraperDb,
        'raw_message_dispatch',
      ),
      raw_message_dispatch_stream: subscriptionResolver(
        scraperDb,
        'raw_message_dispatch',
      ),
    },
  };
}

function selectResolver(scraperDb: ScraperDbService, table: TableName) {
  return (
    _parent: unknown,
    args: SelectArgs,
    _context: unknown,
    info: GraphQLResolveInfo,
  ) => scraperDb.select(table, withSelectedColumns(args, info));
}

function byPkResolver(scraperDb: ScraperDbService, table: TableName) {
  return (
    _parent: unknown,
    args: { id: number | string },
    _context: unknown,
    info: GraphQLResolveInfo,
  ) => scraperDb.byPk(table, args.id, selectedColumns(info));
}

function withSelectedColumns(
  args: SelectArgs,
  info: GraphQLResolveInfo,
): SelectArgs {
  return {
    ...args,
    columns: selectedColumns(info),
  };
}

function selectedColumns(info: GraphQLResolveInfo): string[] {
  return info.fieldNodes.flatMap((fieldNode) =>
    collectFieldSelections(fieldNode.selectionSet?.selections ?? [], info),
  );
}

function collectFieldSelections(
  selections: readonly SelectionNode[],
  info: GraphQLResolveInfo,
): string[] {
  return selections.flatMap((selection) => {
    if (selection.kind === 'Field') {
      return selectedColumn(selection);
    }

    if (selection.kind === 'FragmentSpread') {
      return collectFieldSelections(
        info.fragments[selection.name.value]?.selectionSet.selections ?? [],
        info,
      );
    }

    return collectFieldSelections(selection.selectionSet.selections, info);
  });
}

function selectedColumn(fieldNode: FieldNode): string[] {
  const fieldName = fieldNode.name.value;
  return fieldName === '__typename' ? [] : [fieldName];
}

function aggregateSubscriptionResolver(
  scraperDb: ScraperDbService,
  table: TableName,
) {
  return {
    resolve: (payload: Awaited<ReturnType<ScraperDbService['aggregate']>>) =>
      payload,
    subscribe: async function* (_parent: unknown, args: SelectArgs) {
      yield await scraperDb.aggregate(table, args);
    },
  };
}

function subscriptionResolver(scraperDb: ScraperDbService, table: TableName) {
  return {
    resolve: (payload: Row[]) => payload,
    subscribe: async function* (_parent: unknown, args: SelectArgs) {
      yield await scraperDb.select(table, args);
    },
  };
}

function byPkSubscriptionResolver(
  scraperDb: ScraperDbService,
  table: TableName,
) {
  return {
    resolve: (payload: Row | null) => payload,
    subscribe: async function* (
      _parent: unknown,
      args: { id: number | string },
    ) {
      yield await scraperDb.byPk(table, args.id);
    },
  };
}
