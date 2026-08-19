import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cacheControlHeaderForGraphqlRequestBody,
  normalizeGraphqlRequestBody,
  stripUnusedVariableDefinitions,
} from './request-compatibility.js';
import { buildByPk, buildCount, buildSelect } from './sql.js';

describe('scraper database SQL', () => {
  it('builds bounded parameterized selects', () => {
    const query = buildSelect('domain', {
      columns: ['id', 'name', 'unknown'],
      limit: 5,
      offset: 2,
      order_by: { id: 'desc_nulls_first' },
      where: { _or: [{ id: { _gte: 1 } }, { name: { _eq: 'ethereum' } }] },
    });
    assert.equal(
      query.sql,
      'SELECT "id", "name" FROM "domain" WHERE (((("id" >= $1)) OR (("name" = $2)))) ORDER BY "id" DESC NULLS FIRST LIMIT $3 OFFSET $4',
    );
    assert.deepEqual(query.values, [1, 'ethereum', 5, 2]);
  });

  it('builds cursor ordering and windowed counts', () => {
    const select = buildSelect('raw_message_dispatch', {
      cursor: [{ initial_value: { nonce: 10 }, ordering: 'DESC' }],
    });
    assert.match(
      select.sql,
      /WHERE \("nonce" <= \$1\) ORDER BY "nonce" DESC LIMIT \$2$/,
    );
    assert.deepEqual(select.values, [10, 500]);

    const count = buildCount('message_view', {
      distinct_on: ['origin_domain'],
      limit: 2,
      offset: 1,
    });
    assert.equal(
      count.sql,
      'SELECT COUNT(*)::int AS count FROM (SELECT DISTINCT ON ("origin_domain") 1 FROM "message_view" LIMIT $1 OFFSET $2) AS rows',
    );
    assert.deepEqual(count.values, [2, 1]);
  });

  it('builds primary-key queries and rejects unsafe inputs', () => {
    assert.equal(
      buildByPk('domain', 1, ['name']).sql,
      'SELECT "name" FROM "domain" WHERE "id" = $1 LIMIT 1',
    );
    assert.throws(() => buildByPk('message_view', 1), /primary-key/);
    assert.throws(() => buildSelect('domain', { limit: 501 }), /maximum/);
    assert.throws(
      () =>
        buildSelect('domain', { where: { id: { _in: Array(201).fill(1) } } }),
      /maximum/,
    );
    assert.throws(
      () => buildSelect('domain', { where: { id: { _contains: 'x' } } }),
      /Unsupported comparison operator/,
    );
  });
});

describe('GraphQL request compatibility', () => {
  it('removes unused variable definitions', () => {
    assert.equal(
      stripUnusedVariableDefinitions(
        'query Test($used: Int!, $unused: String) { domain(limit: $used) { id } }',
      ),
      'query Test ($used: Int!) { domain(limit: $used) { id } }',
    );
    const body = { query: 'query Test($unused: Int) { domain { id } }' };
    normalizeGraphqlRequestBody(body);
    assert.equal(body.query, 'query Test { domain { id } }');
  });

  it('derives bounded cache headers', () => {
    assert.equal(
      cacheControlHeaderForGraphqlRequestBody({
        query: 'query @cached(ttl: 999) { domain { id } }',
      }),
      'max-age=300, public',
    );
    assert.equal(
      cacheControlHeaderForGraphqlRequestBody({ query: '{ domain { id } }' }),
      null,
    );
  });
});
