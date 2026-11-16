import assert from 'node:assert/strict';
import { it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://localhost/scraper_sql_test';
const { EventStore, STREAMS } = await import('./event-store.js');

void it('keeps gas payments without receipts and prefers recorded log metadata', async () => {
  let query = '';
  const store = new EventStore({
    async queryLive(sql) {
      query = sql;
      return [];
    },
  });
  await store.notifiedEvents('gas_payment', ['1']);
  assert.match(query, /LEFT JOIN "transaction"/);
  assert.match(query, /LEFT JOIN "block"/);
  for (const [field, relation, fallback, alias] of [
    ['transaction_hash', 'event_transaction', 'hash', 'origin_tx_hash'],
    ['block_hash', 'event_block', 'hash', 'origin_block_hash'],
    ['block_number', 'event_block', 'height', 'origin_block_height'],
  ]) {
    assert(
      query.includes(
        `COALESCE("event_row"."${field}", "${relation}"."${fallback}") AS "${alias}"`,
      ),
    );
  }
});

void it('includes block identity only in the provisional Merkle projection', async () => {
  const queries: string[] = [];
  const store = new EventStore({
    async queryLive(query) {
      queries.push(query);
      return [];
    },
  });
  for await (const row of store.confirmationEventRows(
    'merkle_tree_insertion',
    1,
    [0n, 0, 0n],
    100n,
    1,
  )) {
    assert.fail(`Unexpected row: ${JSON.stringify(row)}`);
  }
  assert.equal(queries.length, 1);
  assert.match(queries[0], /SELECT .*event_row\.block_hash, event_row\.id/);
  assert.ok(!STREAMS.merkle_tree_insertion.columns.includes('block_hash'));
});

void it('filters confirmation dispatch, delivery and gas rows in SQL before enrichment', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const store = new EventStore({
    queryLive: async (sql, values = []) => {
      queries.push({ sql, values });
      return [];
    },
  });
  const ids = new Set([`\\x${'ab'.repeat(32)}`]);
  for await (const row of store.confirmationMessageRows(
    1,
    [0n, 0, 0n],
    10n,
    new Map(),
    0,
    ids,
  )) {
    assert.fail(`Unexpected row ${JSON.stringify(row)}`);
  }
  assert.equal(queries.length, 1);
  assert.equal(
    queries[0]?.sql.match(/msg_id = ANY\(\$7::bytea\[\]\)/g)?.length,
    3,
  );
  assert.deepEqual(queries[0]?.values[6], [...ids]);
  for await (const row of store.confirmationMessageRows(
    1,
    [0n, 0, 0n],
    10n,
    new Map(),
    0,
    new Set(),
  )) {
    assert.fail(`Unexpected row ${JSON.stringify(row)}`);
  }
  assert.equal(queries.length, 1);
});
