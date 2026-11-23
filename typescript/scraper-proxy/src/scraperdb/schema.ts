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

// Only the small domain catalog exposes comparisons on every result column.
const domainColumns = Object.entries(tableFields.domain);
export const schema = [
  source,
  `enum domain_select_column { ${Object.keys(tableFields.domain).join(' ')} }
   input domain_bool_exp {
     _and: [domain_bool_exp!]
     _or: [domain_bool_exp!]
     _not: domain_bool_exp
     ${domainColumns.map(([name, type]) => `${name}: ${type}_comparison_exp`).join('\n')}
   }
   input domain_order_by {
     ${domainColumns.map(([name]) => `${name}: order_by`).join('\n')}
   }`,
  ...[...new Set(Object.values(tableFields.domain))].map(
    (type) => `input ${type}_comparison_exp {
      ${['_eq', '_gt', '_gte', '_lt', '_lte', '_neq'].map((op) => `${op}: ${type}`).join('\n')}
      _in: [${type}!]
      _nin: [${type}!]
      _is_null: Boolean
    }`,
  ),
].join('\n');
