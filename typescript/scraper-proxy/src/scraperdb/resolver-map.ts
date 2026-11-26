import {
  Kind,
  GraphQLError,
  type GraphQLResolveInfo,
  type SelectionNode,
  type FieldNode,
} from 'graphql';

import type { MercuriusContext } from 'mercurius';

import type { DiagnosticsService } from '../diagnostics/service.js';
import { validateHistoryRequest } from './history-policy.js';
import { scalarResolvers } from './scalars.js';
import type {
  MerkleTreeArgs,
  MerkleTreePageArgs,
  MessageSelectArgs,
  ScraperDbService,
} from './scraperdb.service.js';
import type { CountArgs, SelectArgs } from './sql.js';
import type { TableName } from './tables.js';

declare module 'mercurius' {
  interface MercuriusContext {
    scraperDb: ScraperDbService;
  }
}

export function buildResolvers(diagnostics?: DiagnosticsService) {
  const getDiagnostics = () => {
    if (!diagnostics)
      throw new GraphQLError('Diagnostics are not configured', {
        extensions: { code: 'DIAGNOSTICS_UNAVAILABLE' },
      });
    return diagnostics;
  };
  const select =
    (table: TableName) =>
    (
      _parent: unknown,
      args: SelectArgs,
      { scraperDb: db }: MercuriusContext,
      info: GraphQLResolveInfo,
    ) =>
      db.select(table, { ...args, columns: selectedColumns(info) });
  const byPk =
    (table: TableName) =>
    (
      _parent: unknown,
      { id }: { id: number | string },
      { scraperDb: db }: MercuriusContext,
      info: GraphQLResolveInfo,
    ) =>
      db.byPk(table, id, selectedColumns(info));
  const aggregate = (
    _parent: unknown,
    args: SelectArgs,
    { scraperDb: db }: MercuriusContext,
    info: GraphQLResolveInfo,
  ) => {
    validateHistoryRequest(args, true);
    return db.aggregate('message_view', args, nestedColumns(info, 'nodes'));
  };

  return {
    ...scalarResolvers,
    message_view_aggregate_fields: {
      count: (
        { args, table }: { args: SelectArgs; table: TableName },
        count: CountArgs,
        { scraperDb: db }: MercuriusContext,
      ) => db.count(table, args, count),
    },
    query_root: {
      merkle_tree_insertions: (
        _parent: unknown,
        args: MerkleTreePageArgs,
        { scraperDb: db }: MercuriusContext,
      ) => db.merkleTreeInsertions(args),
      merkle_tree_insertion: (
        _parent: unknown,
        args: MerkleTreeArgs & { leaf_index: unknown },
        { scraperDb: db }: MercuriusContext,
      ) => db.merkleTreeInsertion(args),
      merkle_tree_snapshot: (
        _parent: unknown,
        args: MerkleTreeArgs,
        { scraperDb: db }: MercuriusContext,
      ) => db.merkleTreeSnapshot(args),
      message_activity: (
        _parent: unknown,
        args: { message_id: string; before_id?: string; limit?: number },
      ) =>
        getDiagnostics().history(args.message_id, args.before_id, args.limit),
      message_diagnostics: async (
        _parent: unknown,
        args: { message_id: string },
      ) => (await getDiagnostics().snapshots([args.message_id]))[0],
      domain: select('domain'),
      domain_by_pk: byPk('domain'),
      message_view: (
        _parent: unknown,
        args: MessageSelectArgs,
        { scraperDb: db }: MercuriusContext,
        info: GraphQLResolveInfo,
      ) => {
        validateHistoryRequest(args);
        return db.selectMessages({ ...args, columns: selectedColumns(info) });
      },
      message_view_aggregate: aggregate,
      raw_message_dispatch: select('raw_message_dispatch'),
      raw_message_dispatch_by_pk: byPk('raw_message_dispatch'),
    },
  };
}

function selectedColumns(
  info: GraphQLResolveInfo,
  nodes = info.fieldNodes,
): string[] {
  return nodes
    .flatMap((node) =>
      [...fields(node.selectionSet?.selections ?? [], info)].map(
        (field) => field.name.value,
      ),
    )
    .filter((name) => name !== '__typename');
}

function nestedColumns(
  info: GraphQLResolveInfo,
  name: string,
): string[] | undefined {
  const nodes = info.fieldNodes
    .flatMap((node) => [...fields(node.selectionSet?.selections ?? [], info)])
    .filter((field) => field.name.value === name);
  return nodes.length ? selectedColumns(info, nodes) : undefined;
}

function* fields(
  selections: readonly SelectionNode[],
  info: GraphQLResolveInfo,
): Generator<FieldNode> {
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) yield selection;
    else
      yield* fields(
        selection.kind === Kind.FRAGMENT_SPREAD
          ? (info.fragments[selection.name.value]?.selectionSet.selections ??
              [])
          : selection.selectionSet.selections,
        info,
      );
  }
}
