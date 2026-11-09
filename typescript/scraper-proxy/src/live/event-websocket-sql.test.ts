import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://localhost/scraper_sql_test';
const { EventStore, STREAMS, gasPaymentColumns, gasPaymentMetadataJoins } =
  await import('./event-store.js');

void describe('gas payment SQL helpers', () => {
  void it('uses recorded log metadata before receipt enrichment and preserves legacy aliases', () => {
    assert.equal(
      gasPaymentColumns({
        columns: ['id', 'tx_id', 'payment'],
        domain: 'domain',
        projection: 'unused unqualified projection',
        table: 'gas_payment',
      }),
      '"event_row"."id", "event_row"."tx_id", "event_row"."payment", ' +
        'COALESCE("event_row"."transaction_hash", "event_transaction"."hash") AS "origin_tx_hash", ' +
        'COALESCE("event_row"."block_hash", "event_block"."hash") AS "origin_block_hash", ' +
        'COALESCE("event_row"."block_number", "event_block"."height") AS "origin_block_height"',
    );
  });

  void it('uses left joins for both optional metadata relations', () => {
    assert.equal(
      gasPaymentMetadataJoins(),
      ' LEFT JOIN "transaction" AS "event_transaction" ON "event_transaction"."id" = "event_row"."tx_id"' +
        ' LEFT JOIN "block" AS "event_block" ON "event_block"."id" = "event_transaction"."block_id"',
    );
  });
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
  const { EventStore } = await import('./event-store.js');
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
