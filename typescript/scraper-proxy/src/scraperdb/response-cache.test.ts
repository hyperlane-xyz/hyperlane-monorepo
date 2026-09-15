import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getOperationAST, parse } from 'graphql';

import { GraphqlResponseCache } from './response-cache.js';

void it('canonicalizes generated nested variable-key permutations', () => {
  const cache = new GraphqlResponseCache();
  const query = `
    query Cached($filter: domain_bool_exp!) @cached(ttl: 30) {
      domain(where: $filter) { id }
    }
  `;
  const document = parse(query);
  const operation = getOperationAST(document);
  assert(operation);
  for (let index = 0; index < 200; index++) {
    const entries: Array<[string, unknown]> = [
      ['id', { _eq: index }],
      ['is_deprecated', { _eq: index % 2 === 0 }],
      ['name', { _eq: `domain-${index}` }],
    ];
    const forward = { filter: Object.fromEntries(entries) };
    const reverse = { filter: Object.fromEntries(entries.toReversed()) };
    const write = cache.prepare(document, operation, null, forward);
    const read = cache.prepare(document, operation, null, reverse);
    assert(write && read);
    cache.write(write, `result-${index}`);
    assert.equal(cache.read(read)?.body, `result-${index}`);
  }
});
