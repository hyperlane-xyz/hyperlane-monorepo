import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
