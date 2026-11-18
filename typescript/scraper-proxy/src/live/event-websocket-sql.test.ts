import assert from 'node:assert/strict';
import { it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://localhost/scraper_sql_test';
const { EventStore, STREAMS } = await import('./event-store.js');

void it('binds every domain/policy pair in one confirmation snapshot', async () => {
  let query = '';
  let parameters: unknown[] = [];
  const store = new EventStore({
    async queryLive(sql, values = []) {
      query = sql;
      parameters = values;
      return [];
    },
  });
  const snapshots = await store.confirmationSnapshots(
    new Map([
      [0, new Set([1, 4294967294])],
      [12, new Set([1])],
    ]),
  );
  assert.deepEqual(parameters, [
    [1, -2, 1],
    [0, 0, 12],
  ]);
  assert.match(query, /unnest\(\$1::integer\[\], \$2::bigint\[\]\)/);
  assert.match(query, /h\.head_height-requested\.confirmations/);
  assert.deepEqual(
    snapshots,
    new Map([
      [0, new Map()],
      [12, new Map()],
    ]),
  );
});

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

void it('reads one domain range across dispatch, delivery and gas with a stable page cursor', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const store = new EventStore({
    queryLive: async (sql, values = []) => {
      queries.push({ sql, values });
      return [];
    },
  });
  for await (const page of store.messageChanges(1, [5n, 1, 10n], 20n))
    assert.fail('Unexpected page of length ' + page.length);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values.slice(0, 5), [1, '5', 1, '10', '20']);
  for (const table of [
    'raw_message_dispatch',
    'delivered_message',
    'gas_payment',
  ])
    assert.ok(queries[0].sql.includes(table));
  // Each arm must bound its own scan; an outer-only LIMIT re-reads the range per page.
  assert.equal(
    queries[0].sql.match(
      /\)>\(\$2::bigint,\$3::integer,\$4::bigint\)\s+ORDER BY \w+, id LIMIT \$6\)/g,
    )?.length,
    3,
  );
});
