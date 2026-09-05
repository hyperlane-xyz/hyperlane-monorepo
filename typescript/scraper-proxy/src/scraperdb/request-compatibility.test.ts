import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { Parser } from 'graphql/language/parser.js';

import {
  normalizeGraphqlRequestBody,
  stripUnusedVariableDefinitions,
} from './request-compatibility.js';

void describe('GraphQL request compatibility', () => {
  void it('removes unused variable definitions', () => {
    const normalized = stripUnusedVariableDefinitions(
      'query Test($used: Int!, $unused: String) { domain(limit: $used) { id } }',
    );
    assert.match(normalized, /\$used: Int!/);
    assert.doesNotMatch(normalized, /unused/);
    const body = { query: 'query Test($unused: Int) { domain { id } }' };
    normalizeGraphqlRequestBody(body);
    assert.doesNotMatch(body.query, /unused/);
  });

  void it('parses variable definitions and fragment usage as GraphQL', () => {
    const query = stripUnusedVariableDefinitions(`
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
});

void describe('query normalization cache', () => {
  void it('reuses normalization across variables and preserves batch/operation semantics', () => {
    const parser = mock.method(Parser.prototype, 'parseDocument');
    try {
      const query = `# shared document
        query First($used: Int!, $unused: String) { domain(limit: $used) { id } }
        query Second($other: Int) { domain(limit: $other) { name } }`;
      const first = { query, operationName: 'First', variables: { used: 1 } };
      const second = {
        query,
        operationName: 'Second',
        variables: { other: 7 },
      };
      normalizeGraphqlRequestBody([first, second, null, { query: 42 }]);
      assert.equal(parser.mock.callCount(), 1);
      assert.equal(first.query, second.query);
      assert.doesNotMatch(first.query, /unused/);
      assert.match(first.query, /\$used: Int!/);
      assert.match(first.query, /\$other: Int/);
      assert.equal(first.operationName, 'First');
      assert.deepEqual(second.variables, { other: 7 });
    } finally {
      parser.mock.restore();
    }
  });

  void it('does not cache malformed or oversized query text', () => {
    const parser = mock.method(Parser.prototype, 'parseDocument');
    try {
      const malformed = 'query Broken(';
      assert.equal(stripUnusedVariableDefinitions(malformed), malformed);
      assert.equal(stripUnusedVariableDefinitions(malformed), malformed);
      const oversized =
        '# ' + 'x'.repeat(8192) + '\nquery Large { domain { id } }';
      const normalized = stripUnusedVariableDefinitions(oversized);
      assert.equal(stripUnusedVariableDefinitions(oversized), normalized);
      const expanded = `query Expanded { domain { ${Array.from({ length: 500 }, (_, i) => `a${i}:id`).join(' ')} } }`;
      assert(expanded.length < 8192);
      const expandedNormalized = stripUnusedVariableDefinitions(expanded);
      assert(expanded.length + expandedNormalized.length > 8192);
      assert.equal(
        stripUnusedVariableDefinitions(expanded),
        expandedNormalized,
      );
      assert.equal(parser.mock.callCount(), 6);
    } finally {
      parser.mock.restore();
    }
  });

  void it('bounds entries and retains recently used query text', () => {
    const parser = mock.method(Parser.prototype, 'parseDocument');
    try {
      const queries = Array.from(
        { length: 65 },
        (_, i) => `query CacheBound${i} { domain { id } }`,
      );
      for (const query of queries.slice(0, 64))
        stripUnusedVariableDefinitions(query);
      assert.equal(parser.mock.callCount(), 64);
      stripUnusedVariableDefinitions(queries[0]);
      stripUnusedVariableDefinitions(queries[64]);
      stripUnusedVariableDefinitions(queries[0]);
      assert.equal(parser.mock.callCount(), 65);
      stripUnusedVariableDefinitions(queries[1]);
      assert.equal(parser.mock.callCount(), 66);
    } finally {
      parser.mock.restore();
    }
  });
});
