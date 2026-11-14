// Generates testdata/validation.json: graphql-js parse + validate results
// (specifiedRules + scraperProxyValidationRule, maxTokens 10000) for a corpus.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost/unused';
const here = dirname(new URL(import.meta.url).pathname);
const dist = join(here, '../../../../../typescript/scraper-proxy/dist');
const require = createRequire(join(dist, 'module.js'));
const g = require('graphql');
const { schema: source } = await import(
  pathToFileURL(join(dist, 'scraperdb/schema.js')).href
);
const { scraperProxyValidationRule } = await import(
  pathToFileURL(join(dist, 'scraperdb/validation.js')).href
);
const { scalarResolvers } = await import(
  pathToFileURL(join(dist, 'scraperdb/scalars.js')).href
);
const schema = g.buildSchema(source);
// mercurius defineResolvers: copy scalar implementations onto the schema types.
for (const [name, resolver] of Object.entries(scalarResolvers)) {
  const type = schema.getType(name);
  for (const prop of Object.keys(resolver)) type[prop] = resolver[prop];
}
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join(' ');
const queries = [
  '{ domain { id name } }',
  '{ a b }',
  '{ __schema { x } a }',
  '{ __schema { queryType { name } } }',
  '{ __type(name: "domain") { fields { type { fields { type { fields { name } } } } } } }',
  '{ domian { id } }',
  '{ domain { nam } }',
  '{ domain }',
  '{ domain { id { x } } }',
  '{ domain(limit: "x") { id } }',
  '{ domain(limit: 3000000000) { id } }',
  '{ domain(limit: 1.5) { id } }',
  '{ domain(where: {nme: {_eq: "x"}}) { id } }',
  '{ domain(where: {name: {_eq: 1}}) { id } }',
  '{ domain(where: {id: {_eq: null}, name: {_in: [null]}}) { id } }',
  '{ domain(order_by: {id: up}) { id } }',
  '{ domain(order_by: {id: "asc"}) { id } }',
  '{ domain(order_by: [{id: asc}, {name: desc_nulls_last}]) { id } }',
  '{ domain(where: 5) { id } }',
  '{ domain(where: {chain_id: {_eq: FOO}}) { id } }',
  '{ domain(where: {chain_id: {_eq: [1]}}) { id } }',
  '{ domain(where: {chain_id: {_eq: {a: 1}}}) { id } }',
  '{ domain(where: {chain_id: {_eq: 1, _eq: 2}}) { id } }',
  '{ domain(limit: 1, limit: 2) { id } }',
  '{ domain(lmit: 1) { id } }',
  '{ domain_by_pk { id } }',
  '{ domain_by_pk(id: null) { id } }',
  '{ message_activity(message_id: "x") { has_more } }',
  '{ message_activity { has_more } }',
  'query Q($a: Int, $a: Int) { domain(limit: $a) { id } }',
  'query Q { domain(limit: $x) { id } }',
  '{ domain(limit: $x) { id } }',
  'query Q($x: Int) { domain { id } }',
  'query ($x: Int) { domain { id } }',
  'query Q($x: String) { domain(limit: $x) { id } }',
  'query Q($x: Int) { domain_by_pk(id: $x) { id } }',
  'query Q($x: Int = 1) { domain_by_pk(id: $x) { id } }',
  'query Q($x: [Int]) { domain(limit: $x) { id } }',
  'query Q($x: Foo) { domain { id } }',
  'query Q($x: domain) { domain { id } }',
  'query Q($x: Strin) { domain { id } }',
  'query Q($x: Int!) { message_activity(message_id: "m", limit: $x) { has_more } }',
  'query Q($x: Int) { message_activity(message_id: "m", limit: $x) { has_more } }',
  '{ domain { ...F } }',
  '{ domain { ...F } } fragment F on domain { id } fragment F on domain { name }',
  '{ domain { id } } fragment F on domain { id }',
  '{ domain { ...F } } fragment F on domain { ...G } fragment G on domain { ...F }',
  '{ domain { ...F } } fragment F on domain { ...F }',
  '{ domain { ...F } } fragment F on message_view { id }',
  '{ domain { ... on message_view { id } } }',
  '{ domain { ... on Int { id } } }',
  '{ domain { ...F } } fragment F on Int { id }',
  '{ domain { ... on Foo { id } } }',
  '{ domain { id @skip } }',
  '{ domain { id @skip(if: true) @skip(if: false) } }',
  '{ domain { id @foo } }',
  '{ domain { id @cached } }',
  'query @cached(ttl: 30) @cached(ttl: 30) { domain { id } }',
  'query @cached(tll: 30) { domain { id } }',
  'query @cached(ttl: "x") { domain { id } }',
  '{ domain { id @include(if: true, iff: 1) } }',
  '{ domain { x: id x: name } }',
  '{ domain { id: name } }',
  '{ domain(limit: 1) { id } domain(limit: 2) { id } }',
  '{ domain(where: {id: {_eq: 1}, name: {_eq: "a"}}) { id } domain(where: {name: {_eq: "a"}, id: {_eq: 1}}) { id } }',
  '{ domain { id } domain { id: name } }',
  '{ a: domain { id } a: message_view { id } }',
  '{ domain { ...F ...G } } fragment F on domain { x: id } fragment G on domain { x: name }',
  '{ message_view_aggregate { aggregate { count(columns: [id]) } nodes { id } } }',
  '{ message_view_aggregate { aggregate { count(columns: [nope]) } } }',
  'mutation { domain { id } }',
  'subscription { domain { id } }',
  'query A { domain { id } } query B { domain { id } }',
  'query A { domain { id } } query A { domain { id } }',
  '{ domain { id } } { domain { id } }',
  'type Foo { a: Int } { domain { id } }',
  'schema { query: Foo } { domain { id } }',
  `{ ${many(11, (i) => `a${i}: domain { id }`)} }`,
  `{ domain { ${many(251, (i) => `a${i}: id`)} } }`,
  `{ ${many(101, (i) => `f${i}`)} }`,
  '{ domain { id } message_view(where: {_and: [{id: {_eq: "1"}}], _not: {msg_id: {_is_null: true}}}) { id is_provisional } }',
  'query ($c: [message_view_stream_cursor_input!]) { message_view(cursor: $c) { id } }',
  '{ message_view(cursor: [{initial_value: {}}]) { id } }',
  '{ message_view(cursor: [{ordering: ASC}]) { id } }',
  '{ message_view(cursor: {initial_value: {id: 1}, ordering: DSC}) { id } }',
  '{ message_view(order_by: {is_provisional: asc}) { id } }',
  '{ message_view(distinct_on: [id, nope]) { id } }',
  '{ message_diagnostics(message_id: "m") { relayers { phase modules { signatures { threshold } } } } }',
  '{ message_diagnostics(message_id: "m") { relayers } }',
  '{ __typename domain { __typename } }',
  '{ domain(where: {id: {_in: 1}}) { id } }',
  '{ domain(where: {_or: {id: {_eq: 1}}}) { id } }',
  '"desc" query Q { domain { id } }',
  'query Q("d" $x: Int) { domain(limit: $x) { id } }',
  `{ __typename } ${many(1500, (i) => `fragment F${i} on query_root { __typename }`)}`,
  '{ domain(where: {name: {_eq: """block"""}}) { id } }',
  '{ domain { ...on domain { id } } }',
  '{ domain { id @deprecated } }',
  'query Q($x: Int @deprecated) { domain(limit: $x) { id } }',
  'query Q($x: Int = "s") { domain(limit: $x) { id } }',
  'query Q($x: domain_bool_exp = {id: {_eq: 1}}) { domain(where: $x) { id } }',
  'query Q($x: domain_bool_exp = {idd: 1}) { domain(where: $x) { id } }',
  '{ domain { id(x: 1) } }',
  '{ message_view(limit: 1) { id } message_view(limit: 1) { name: id } }',
];
const out = queries.map((query) => {
  try {
    const doc = g.parse(query, { maxTokens: 10_000 });
    const errors = g.validate(schema, doc, [
      ...g.specifiedRules,
      scraperProxyValidationRule,
    ]);
    return {
      query,
      errors: errors.map((e) => ({
        message: e.message,
        locations: e.locations ?? [],
      })),
    };
  } catch (e) {
    return {
      query,
      syntax: { message: e.message, locations: e.locations ?? [] },
    };
  }
});
writeFileSync(
  join(here, '../testdata/validation.json'),
  JSON.stringify(out, null, 1),
);
console.log(`wrote ${out.length} cases`);
