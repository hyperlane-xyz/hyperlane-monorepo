import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeGraphqlRequestBody,
  stripUnusedVariableDefinitions,
} from './request-compatibility.js';
import { buildByPk, buildCount, buildSelect } from './sql.js';

void describe('scraper database SQL', () => {
  void it('builds bounded parameterized selects', () => {
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

  void it('builds cursor ordering and windowed counts', () => {
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

  void it('builds column and distinct aggregate counts', () => {
    assert.equal(
      buildCount(
        'message_view',
        {},
        {
          columns: ['origin_domain'],
          distinct: true,
        },
      ).sql,
      'SELECT COUNT(DISTINCT "origin_domain")::int AS count FROM "message_view"',
    );
    assert.equal(
      buildCount(
        'message_view',
        { limit: 10, order_by: { nonce: 'desc' } },
        { columns: ['origin_domain', 'destination_domain'], distinct: true },
      ).sql,
      'SELECT COUNT(DISTINCT ("origin_domain", "destination_domain"))::int AS count FROM (SELECT "origin_domain", "destination_domain" FROM "message_view" ORDER BY "nonce" DESC LIMIT $1) AS rows',
    );
  });

  void it('builds primary-key queries and rejects unsafe inputs', () => {
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

  void it('rejects expensive public pattern operators', () => {
    for (const operator of ['_like', '_ilike', '_regex', '_similar']) {
      assert.throws(
        () =>
          buildSelect('domain', {
            where: { name: { [operator]: 'eth%' } },
          }),
        /Unsupported comparison operator/,
      );
    }
  });

  void it('treats an empty OR as false', () => {
    const query = buildSelect('domain', { where: { _or: [] } });
    assert.match(query.sql, /WHERE \(FALSE\)/);
  });

  void it('treats an empty OR child as true', () => {
    const query = buildSelect('domain', {
      where: { _or: [{ id: { _eq: 1 } }, {}] },
    });
    assert.doesNotMatch(query.sql, /WHERE/);
    assert.deepEqual(query.values, [500]);
  });

  void it('preserves empty NOT and null comparison semantics', () => {
    assert.match(
      buildSelect('domain', { where: { _not: {} } }).sql,
      /WHERE \(FALSE\)/,
    );
    assert.doesNotMatch(
      buildSelect('domain', { where: { id: { _is_null: null } } }).sql,
      /WHERE/,
    );
  });

  void it('binds IN lists as PostgreSQL arrays', () => {
    const query = buildSelect('domain', {
      where: { id: { _in: [1, 2, 3], _nin: [4, 5] } },
    });
    assert.match(query.sql, /"id" = ANY\(\$1\)/);
    assert.match(query.sql, /"id" <> ALL\(\$2\)/);
    assert.deepEqual(query.values, [[1, 2, 3], [4, 5], 500]);
  });
});

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
