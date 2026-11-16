import assert from 'node:assert/strict';
import { it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://localhost/scraper_sql_test';
const { EventStore, STREAMS } = await import('./event-store.js');

void it('shares only identical in-flight event pages, independently of confirmation labels', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queries = 0;
  const store = new EventStore({
    async queryLive() {
      queries++;
      await held;
      return [];
    },
  });
  const read = async (domain = 1, through = 10n, confirmations = 0) => {
    for await (const row of store.confirmationEventRows(
      'dispatch',
      domain,
      [0n, 0, 0n],
      through,
      confirmations,
    ))
      assert.fail(`Unexpected row ${JSON.stringify(row)}`);
  };
  const first = read();
  const sameRange = read(1, 10n, 2);
  assert.equal(queries, 1);
  const otherDomain = read(2);
  const otherRange = read(1, 11n);
  assert.equal(queries, 3);
  store.invalidate();
  const afterRollback = read();
  assert.equal(queries, 4);
  release();
  await Promise.all([first, sameRange, otherDomain, otherRange, afterRollback]);
  await read();
  assert.equal(queries, 5, 'completed pages are never reused');
});

void it('evicts failed shared reads so later subscribers can retry', async () => {
  let queries = 0;
  const store = new EventStore({
    async queryLive() {
      if (++queries === 1) throw new Error('read failed');
      return [];
    },
  });
  const read = async () => {
    for await (const row of store.confirmationEventRows(
      'dispatch',
      1,
      [0n, 0, 0n],
      10n,
      0,
    ))
      assert.fail(`Unexpected row ${JSON.stringify(row)}`);
  };
  await Promise.all([
    assert.rejects(read(), /read failed/),
    assert.rejects(read(), /read failed/),
  ]);
  assert.equal(queries, 1);
  await read();
  assert.equal(queries, 2);
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
