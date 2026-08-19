import { Kind, type GraphQLResolveInfo, type SelectionNode } from 'graphql';

import { scalarResolvers } from './scalars.js';
import { ScraperDbService } from './scraperdb.service.js';
import type { CountArgs, SelectArgs } from './sql.js';
import type { TableName } from './tables.js';

type ResolverArgs = SelectArgs & { id?: number | string };

export function buildResolvers(db: ScraperDbService): Record<string, unknown> {
  const select =
    (table: TableName) =>
    (
      _parent: unknown,
      args: SelectArgs,
      _context: unknown,
      info: GraphQLResolveInfo,
    ) =>
      db.select(table, { ...args, columns: selectedColumns(info) });
  const byPk =
    (table: TableName) =>
    (
      _parent: unknown,
      { id }: { id: number | string },
      _context: unknown,
      info: GraphQLResolveInfo,
    ) =>
      db.byPk(table, id, selectedColumns(info));
  const aggregate = (
    _parent: unknown,
    args: SelectArgs,
    _context: unknown,
    info: GraphQLResolveInfo,
  ) => db.aggregate('message_view', args, nestedColumns(info, 'nodes'));

  return {
    ...scalarResolvers,
    message_view_aggregate_fields: {
      count: (
        { args, table }: { args: SelectArgs; table: TableName },
        count: CountArgs,
      ) => db.count(table, args, count),
    },
    query_root: {
      domain: select('domain'),
      domain_by_pk: byPk('domain'),
      message_view: select('message_view'),
      message_view_aggregate: aggregate,
      raw_message_dispatch: select('raw_message_dispatch'),
      raw_message_dispatch_by_pk: byPk('raw_message_dispatch'),
    },
    subscription_root: {
      domain: subscription((args) => db.select('domain', args)),
      domain_by_pk: subscription(({ id }) => db.byPk('domain', id)),
      domain_stream: subscription((args) => db.select('domain', args)),
      message_view: subscription((args) => db.select('message_view', args)),
      message_view_aggregate: subscription((args, info) =>
        db.aggregate('message_view', args, nestedColumns(info, 'nodes')),
      ),
      message_view_stream: subscription((args) =>
        db.select('message_view', args),
      ),
      raw_message_dispatch: subscription((args) =>
        db.select('raw_message_dispatch', args),
      ),
      raw_message_dispatch_by_pk: subscription(({ id }) =>
        db.byPk('raw_message_dispatch', id),
      ),
      raw_message_dispatch_stream: subscription((args) =>
        db.select('raw_message_dispatch', args),
      ),
    },
  };
}

function subscription<T>(
  load: (args: ResolverArgs, info: GraphQLResolveInfo) => Promise<T>,
) {
  return {
    resolve: (payload: T) => payload,
    subscribe: async function* (
      _parent: unknown,
      args: ResolverArgs,
      _context: unknown,
      info: GraphQLResolveInfo,
    ) {
      yield await load(args, info);
    },
  };
}

function selectedColumns(info: GraphQLResolveInfo): string[] {
  return info.fieldNodes.flatMap((node) =>
    collect(node.selectionSet?.selections ?? [], info),
  );
}

function nestedColumns(
  info: GraphQLResolveInfo,
  field: string,
): string[] | undefined {
  let found = false;
  const visit = (selections: readonly SelectionNode[]): string[] =>
    selections.flatMap((selection) => {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value !== field) return [];
        found = true;
        return collect(selection.selectionSet?.selections ?? [], info);
      }
      return visit(
        selection.kind === Kind.FRAGMENT_SPREAD
          ? (info.fragments[selection.name.value]?.selectionSet.selections ??
              [])
          : selection.selectionSet.selections,
      );
    });
  const columns = visit(
    info.fieldNodes.flatMap((node) => node.selectionSet?.selections ?? []),
  );
  return found ? columns : undefined;
}

function collect(
  selections: readonly SelectionNode[],
  info: GraphQLResolveInfo,
): string[] {
  return selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) {
      return selection.name.value === '__typename'
        ? []
        : [selection.name.value];
    }
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      return collect(
        info.fragments[selection.name.value]?.selectionSet.selections ?? [],
        info,
      );
    }
    return collect(selection.selectionSet.selections, info);
  });
}
