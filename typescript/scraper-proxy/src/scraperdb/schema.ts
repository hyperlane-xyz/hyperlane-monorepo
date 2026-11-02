import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert } from '@hyperlane-xyz/utils/validation';
import { Kind, parse } from 'graphql';

const schemaPath = [
  join(import.meta.dirname, '../graphql/scraperdb-schema.graphql'),
  join(import.meta.dirname, '../../src/graphql/scraperdb-schema.graphql'),
  // ncc emits this module at the bundle root.
  join(import.meta.dirname, 'graphql/scraperdb-schema.graphql'),
].find(existsSync);
assert(schemaPath, 'Missing scraper DB GraphQL schema');
const source = readFileSync(schemaPath, 'utf8');
const document = parse(source);

export const tableFields = {
  domain: fields('domain'),
  message_view: fields('message_view'),
  raw_message_dispatch: fields('raw_message_dispatch'),
};
export type TableName = keyof typeof tableFields;

function fields(name: string): Record<string, string> {
  const definition = document.definitions.find(
    (node) =>
      node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === name,
  );
  assert(
    definition?.kind === Kind.OBJECT_TYPE_DEFINITION,
    `Missing table ${name}`,
  );
  return Object.fromEntries(
    (definition.fields ?? []).map(({ name, type }) => {
      const scalar = type.kind === Kind.NON_NULL_TYPE ? type.type : type;
      assert(
        scalar.kind === Kind.NAMED_TYPE,
        `Expected scalar column ${name.value}`,
      );
      return [name.value, scalar.name.value];
    }),
  );
}

// Hasura's filter/order/cursor shapes repeat each table's fields. Derive them
// from the public row types so adding a column requires one schema edit.
export const schema = [
  source,
  ...Object.entries(tableFields).map(([table, fields]) => {
    const entries = Object.entries(fields);
    // Computed snapshot state is selectable/filterable, but not a history cursor,
    // ordering key, distinct key, or aggregate column.
    const stored = entries.filter(([name]) => name !== 'is_provisional');
    return `
      enum ${table}_select_column { ${stored.map(([name]) => name).join('\n')} }
      input ${table}_bool_exp {
        _and: [${table}_bool_exp!]
        _not: ${table}_bool_exp
        _or: [${table}_bool_exp!]
        ${entries.map(([name, type]) => `${name}: ${type}_comparison_exp`).join('\n')}
      }
      input ${table}_order_by {
        ${stored.map(([name]) => `${name}: order_by`).join('\n')}
      }
      input ${table}_stream_cursor_value_input {
        ${stored.map(([name, type]) => `${name}: ${type}`).join('\n')}
      }
      input ${table}_stream_cursor_input {
        initial_value: ${table}_stream_cursor_value_input!
        ordering: cursor_ordering
      }
    `;
  }),
  ...[...new Set(Object.values(tableFields).flatMap(Object.values))].map(
    (type) => `input ${type}_comparison_exp {
      ${['_eq', '_gt', '_gte', '_lt', '_lte', '_neq'].map((op) => `${op}: ${type}`).join('\n')}
      _in: [${type}!]
      _nin: [${type}!]
      _is_null: Boolean
    }`,
  ),
].join('\n');
