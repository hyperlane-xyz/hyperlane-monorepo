import { assert } from '@hyperlane-xyz/utils/validation';

import { tableFields, type TableName } from './schema.js';

export type { TableName } from './schema.js';

export const tables = {
  domain: table('domain', 'id'),
  message_view: table('message_view'),
  raw_message_dispatch: table(
    'raw_message_dispatch',
    'id',
    'confirmed_raw_message_dispatch',
  ),
};

function table(name: TableName, primaryKey?: string, relation?: string) {
  const columns = Object.keys(tableFields[name]).sort();
  return {
    columns,
    columnSet: new Set(columns),
    primaryKey,
    relation,
  };
}

export function assertColumn(table: TableName, column: string): void {
  assert(
    tables[table].columnSet.has(column),
    `Unsupported column ${table}.${column}`,
  );
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
