import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parse, print } from 'graphql';

import { stripUnusedVariables } from './request-compatibility.js';

function normalize(query: string): string {
  return print(stripUnusedVariables(parse(query)));
}

void describe('GraphQL request compatibility', () => {
  void it('removes unused variable definitions', () => {
    const normalized = normalize(
      'query Test($used: Int!, $unused: String) { domain(limit: $used) { id } }',
    );
    assert.match(normalized, /\$used: Int!/);
    assert.doesNotMatch(normalized, /unused/);
  });

  void it('parses variable definitions and fragment usage as GraphQL', () => {
    const query = normalize(`
      query Test($used: String = ")", $unused: String) {
        ...Domains
      }
      fragment Domains on query_root {
        domain(where: {name: {_eq: $used}}) { id }
      }
    `);
    assert.match(query, /\$used: String = "\)"/);
    assert.doesNotMatch(query, /unused/);
  });

  void it('is idempotent across generated variable subsets', () => {
    for (let size = 1; size <= 200; size++) {
      const definitions = Array.from(
        { length: size },
        (_, index) => `$v${index}: Int`,
      );
      const used = Array.from({ length: size }, (_, index) => index).filter(
        (index) => (index * 31 + size) % 5 === 0,
      );
      const argumentsSource = used
        .map((index) => `a${index}: domain(limit: $v${index}) { id }`)
        .join(' ');
      const query = `query Generated(${definitions.join(', ')}) { ${argumentsSource || 'domain { id }'} }`;
      const once = normalize(query);
      assert.equal(normalize(once), once);
      for (let index = 0; index < size; index++) {
        assert.equal(
          once.includes(`$v${index}: Int`),
          used.includes(index),
          `variable v${index}`,
        );
      }
    }
  });
});
