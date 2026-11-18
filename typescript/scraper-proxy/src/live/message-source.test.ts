import assert from 'node:assert/strict';
import { it } from 'node:test';
import { once, EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MessageSource } from './message-source.js';
import { collectMessageFacts } from './message-facts.js';

const initialHeads = async () =>
  new Map(
    [1, 2].map((domain) => [
      domain,
      { head: 10n, indexed: 10n, confirmed: 5n, hash: undefined },
    ]),
  );
const policy = (confirmations = 0) => ({
  domains: new Set([1, 2]),
  confirmations,
});
function fact(msg_id: string, height = '5') {
  return {
    msg_id,
    origin_domain_id: 1,
    destination_domain_id: 2,
    origin_block_height: height,
    delivery_domain: null,
    delivery_height: null,
    payment_buckets: null,
  };
}
function advance(source: MessageSource, domain: number, height: bigint) {
  const head = {
    domain,
    confirmedHeight: 5n,
    indexedHeight: height,
    headHeight: height,
  };
  source.observe(head);
  source.notify(head);
}

void it('never reinstalls stale receipt data when older SQL finishes last', async () => {
  const events = new EventEmitter();
  const started = once(events, 'started');
  let calls = 0;
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [];
    },
    async messageFacts() {
      const version = ++calls;
      if (version === 1) {
        const released = once(events, 'release');
        events.emit('started');
        await released;
      }
      return collectMessageFacts([
        {
          ...fact('id'),
          origin_tx_gas_price: String(version),
        },
      ]);
    },
  });
  await source.currentHeads();
  const versions: unknown[] = [];
  source.subscribe(
    policy(),
    undefined,
    (frame) => {
      const data = frame.data;
      if (data && typeof data === 'object' && 'origin_tx_gas_price' in data)
        versions.push(data.origin_tx_gas_price);
    },
    assert.fail,
  );
  const old = source.refresh(['id']);
  await started;
  source.invalidateIds(['id']);
  await source.refresh(['id']);
  events.emit('release');
  await old;
  await source.refresh(['id']);
  assert.deepEqual(versions, ['2', '2', '2']);
  assert.equal(calls, 2);
});

void it('backs off a failed domain read without failing subscribers while another domain continues', async () => {
  const queried = new EventEmitter();
  const queries: number[] = [];
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges(domain) {
      queries.push(domain);
      queried.emit('query', domain);
      if (domain === 1) throw new Error('read timed out');
      yield [];
    },
    messageFacts: async () => new Map(),
  });
  await source.currentHeads();
  source.subscribe(
    { domains: new Set([1]), confirmations: 0 },
    undefined,
    assert.fail,
    (error) => assert.fail(String(error)),
  );
  const failed = once(queried, 'query');
  advance(source, 1, 11n);
  await failed;
  await nextTurn();
  // A head during the backoff does not rescan the failing domain.
  advance(source, 1, 12n);
  await nextTurn();
  source.subscribe(
    { domains: new Set([2]), confirmations: 0 },
    undefined,
    assert.fail,
    assert.fail,
  );
  const next = once(queried, 'query');
  advance(source, 2, 11n);
  await next;
  assert.deepEqual(queries, [1, 2]);
});

void it(
  'hydrates only due IDs selected by a browser and sends a changed ID once per range',
  { timeout: 2000 },
  async () => {
    const sent = new EventEmitter();
    const first = once(sent, 'frame');
    const reads: string[][] = [];
    const source = new MessageSource({
      messageHeads: initialHeads,
      async *messageChanges() {
        yield [
          { height: 8n, id: 'old' },
          { height: 11n, id: 'other' },
          { height: 11n, id: 'wanted' },
          { height: 11n, id: 'wanted' },
        ];
      },
      async messageFacts(ids) {
        reads.push(ids);
        return collectMessageFacts(ids.map((id) => fact(id, '11')));
      },
    });
    await source.currentHeads();
    let sends = 0;
    source.subscribe(
      { domains: new Set([1]), confirmations: 0 },
      new Set(['wanted', 'old']),
      () => {
        sends++;
        sent.emit('frame');
      },
      assert.fail,
    );
    advance(source, 1, 11n);
    await first;
    assert.deepEqual(reads, [['wanted']]);
    assert.equal(sends, 1);
    source.stop();
  },
);

void it('limits a failed receipt read to subscribers for the affected IDs', async () => {
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [];
    },
    async messageFacts() {
      throw new Error('receipt read failed');
    },
  });
  await source.currentHeads();
  const failed: string[] = [];
  for (const id of ['first', 'other'])
    source.subscribe(
      { domains: new Set([1]), confirmations: 0 },
      new Set([id]),
      assert.fail,
      () => failed.push(id),
    );
  await source.refresh(['first']);
  assert.deepEqual(failed, ['first']);
});

void it('hides a folded payment bucket until its newest payment is visible', async () => {
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges(domain) {
      yield domain === 2 ? [{ height: 9n, id: 'id' }] : [];
    },
    async messageFacts() {
      return collectMessageFacts([
        {
          ...fact('id'),
          payment_buckets: [
            { domain: 2, height: '6', count: '1', payment: '1', gas: '1' },
            { domain: 2, height: '9', count: '2', payment: '3', gas: '4' },
          ],
        },
      ]);
    },
  });
  await source.currentHeads();
  const totals: string[] = [];
  for (const [n, ids] of [
    [2, new Set(['id'])],
    [2, undefined],
    [0, undefined],
  ] as const)
    source.subscribe(
      policy(n),
      ids,
      (frame) => {
        const data = frame.data;
        if (data && typeof data === 'object' && 'total_payment' in data)
          totals.push(
            `${n}:${ids ? 'id' : 'all'}:${String(data.total_payment)}`,
          );
      },
      assert.fail,
    );
  await source.refresh(['id']);
  assert.deepEqual(totals, ['2:id:1', '2:all:1', '0:all:4']);
  totals.length = 0;
  advance(source, 2, 11n);
  await nextTurn();
  assert.deepEqual(totals, ['2:id:4', '2:all:4']);
});

void it('isolates an invalid ID in a shared fact batch and preserves global subscribers', async () => {
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [
        { height: 11n, id: 'bad' },
        { height: 11n, id: 'good' },
      ];
    },
    async messageFacts() {
      return collectMessageFacts([
        {
          ...fact('bad', '11'),
          payment_buckets: [
            { domain: 1.5, height: '11', count: '1', payment: '1', gas: '1' },
          ],
        },
        fact('good', '11'),
      ]);
    },
  });
  await source.currentHeads();
  const failed: string[] = [],
    sent: string[] = [],
    errors: Record<string, unknown>[] = [];
  for (const id of ['bad', 'good', 'global'])
    source.subscribe(
      policy(),
      id === 'global' ? undefined : new Set([id]),
      (frame) => {
        sent.push(`${id}:${String(frame.type)}`);
        if (id === 'global' && frame.type === 'error') errors.push(frame);
      },
      () => failed.push(id),
    );
  advance(source, 1, 11n);
  await nextTurn();
  assert.deepEqual(failed, ['bad']);
  assert(sent.includes('good:message_upsert'));
  assert(sent.includes('global:message_upsert'));
  assert.deepEqual(errors, [
    {
      type: 'error',
      messageId: 'bad',
      error: 'Invalid payment domain',
    },
  ]);
});

void it('cancels queued domain scans and skips hydration after disconnect', async () => {
  const queries: number[] = [];
  const gates: (() => void)[] = [];
  const source = new MessageSource({
    messageHeads: async () =>
      new Map(
        [1, 2, 3, 4, 5].map((d) => [
          d,
          { head: 10n, indexed: 10n, confirmed: 5n },
        ]),
      ),
    async *messageChanges(domain) {
      queries.push(domain);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield [{ height: 11n, id: 'unused' }];
      assert.fail('Cancelled reader fetched another page');
    },
    messageFacts: async () => assert.fail('Cancelled reader hydrated rows'),
  });
  await source.currentHeads();
  const sub = source.subscribe(
    { domains: new Set([1, 2, 3, 4, 5]), confirmations: 0 },
    undefined,
    assert.fail,
    assert.fail,
  );
  for (let domain = 1; domain <= 5; domain++) advance(source, domain, 11n);
  assert.equal(queries.length, 4);
  sub.unsubscribe();
  for (const release of gates) release();
  await nextTurn();
  assert.deepEqual(queries, [1, 2, 3, 4]);
  assert.equal(source.metrics().changes, 0);
});

void it('starts at the requested frontier and expands history for a deeper late joiner', async () => {
  const ranges: bigint[][] = [];
  const source = new MessageSource({
    messageHeads: async () =>
      new Map([[1, { head: 10000n, indexed: 10000n, confirmed: 9900n }]]),
    async *messageChanges(_domain, after, through) {
      ranges.push([after[0], through]);
      yield [];
    },
    messageFacts: async () => new Map(),
  });
  await source.currentHeads();
  source.subscribe(
    { domains: new Set([1]), confirmations: 0 },
    undefined,
    assert.fail,
    assert.fail,
  );
  advance(source, 1, 10001n);
  await nextTurn();
  assert.deepEqual(ranges, [[10000n, 10001n]]);
  source.subscribe(
    { domains: new Set([1]), confirmations: 1000 },
    undefined,
    assert.fail,
    assert.fail,
  );
  advance(source, 1, 10002n);
  await nextTurn();
  assert.deepEqual(ranges, [
    [10000n, 10001n],
    [9001n, 10000n],
    [10001n, 10002n],
  ]);
});

void it('rejects an oversized history expansion while the zero-confirmation subscriber continues', async () => {
  const source = new MessageSource({
    messageHeads: async () =>
      new Map([[1, { head: 10000n, indexed: 10000n, confirmed: 9900n }]]),
    async *messageChanges(_domain, after, through) {
      if (after[0] < 10000n)
        yield Array.from({ length: 50001 }, () => ({
          height: 9999n,
          id: 'old',
        }));
      else yield [{ height: through, id: 'good' }];
    },
    messageFacts: async () => collectMessageFacts([fact('good', '10001')]),
  });
  await source.currentHeads();
  let sent = 0,
    rejected = 0;
  source.subscribe(
    { domains: new Set([1]), confirmations: 0 },
    undefined,
    () => sent++,
    assert.fail,
  );
  advance(source, 1, 10001n);
  await nextTurn();
  source.subscribe(
    { domains: new Set([1]), confirmations: 1000 },
    undefined,
    assert.fail,
    () => rejected++,
  );
  advance(source, 1, 10002n);
  await nextTurn();
  assert.equal(rejected, 1);
  assert.equal(sent, 2);
});

void it('does not cache a skipped read for a later subscriber', async () => {
  const gates: (() => void)[] = [];
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [];
    },
    async messageFacts(ids) {
      if (ids.some((id) => id !== 'm'))
        await new Promise<void>((resolve) => gates.push(resolve));
      return collectMessageFacts(ids.map((id) => fact(id)));
    },
  });
  await source.currentHeads();
  for (const id of ['x', 'y'])
    source.subscribe(policy(), new Set([id]), () => {}, assert.fail);
  const first = source.subscribe(
    policy(),
    new Set(['m']),
    () => {},
    assert.fail,
  );
  const busy = [source.refresh(['x']), source.refresh(['y'])];
  const queued = source.refresh(['m']);
  first.unsubscribe();
  await nextTurn();
  for (const release of gates) release();
  await Promise.all([...busy, queued]);
  const sent: unknown[] = [];
  source.subscribe(
    policy(),
    undefined,
    (frame) => sent.push(frame.type),
    assert.fail,
  );
  await source.refresh(['m']);
  assert.deepEqual(sent, ['message_upsert']);
});

void it('retries a fact read invalidated by repeated rollbacks without failing subscribers', async () => {
  let calls = 0;
  let source!: MessageSource;
  const rollback = () => {
    const head = {
      domain: 2,
      confirmedHeight: 5n,
      indexedHeight: 9n,
      headHeight: 9n,
      previousIndexedHeight: 10n,
    };
    source.observe(head);
    source.notify(head);
  };
  source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [{ height: 11n, id: 'm' }];
    },
    async messageFacts(ids) {
      if (++calls <= 3) {
        await nextTurn();
        rollback();
      }
      return collectMessageFacts(ids.map((id) => fact(id, '11')));
    },
  });
  await source.currentHeads();
  const upserts: unknown[] = [];
  source.subscribe(
    { domains: new Set([1]), confirmations: 0 },
    undefined,
    (frame) => {
      if (frame.type === 'message_upsert') upserts.push(frame);
    },
    (error) => assert.fail(String(error)),
  );
  advance(source, 1, 11n);
  for (let i = 0; i < 20 && !upserts.length; i++) await nextTurn();
  assert.equal(upserts.length, 1);
  assert(calls > 3, `calls=${calls}`);
});

void it('keeps cached facts a rollback cannot affect', async () => {
  const reads: string[] = [];
  const source = new MessageSource({
    messageHeads: async () =>
      new Map(
        [1, 2, 3].map((domain) => [
          domain,
          { head: 10n, indexed: 10n, confirmed: 5n, hash: undefined },
        ]),
      ),
    async *messageChanges() {
      yield [];
    },
    async messageFacts(ids) {
      reads.push(...ids);
      return collectMessageFacts(
        ids.map((id) => ({
          ...fact(id),
          destination_domain_id: id === 'to3' ? 3 : 2,
          origin_tx_id: '1',
        })),
      );
    },
  });
  await source.currentHeads();
  source.subscribe(
    { domains: new Set([1, 2, 3]), confirmations: 0 },
    undefined,
    () => {},
    assert.fail,
  );
  await source.refresh(['to2', 'to3']);
  const head = {
    domain: 2,
    confirmedHeight: 5n,
    indexedHeight: 9n,
    headHeight: 9n,
    previousIndexedHeight: 10n,
  };
  source.observe(head);
  await source.refresh(['to2', 'to3']);
  assert.deepEqual(reads, ['to2', 'to3', 'to2']);
});

void it('rereads facts still waiting for transaction rows', async () => {
  const reads: string[] = [];
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [];
    },
    async messageFacts(ids) {
      reads.push(...ids);
      return collectMessageFacts(
        ids.map((id) => ({
          ...fact(id),
          origin_tx_id: reads.length > 2 || id === 'done' ? '1' : null,
        })),
      );
    },
  });
  await source.currentHeads();
  source.subscribe(policy(), undefined, () => {}, assert.fail);
  for (let i = 0; i < 3; i++) await source.refresh(['pending', 'done']);
  // Reread until the transaction row arrives, then cache like any other fact.
  assert.deepEqual(reads, ['pending', 'done', 'pending']);
});

// Message facts: origin height and an optional domain 1 payment height, which a
// rollback removes once `rolledBack` is set.
function rollbackSource(
  rows: Record<string, { origin: bigint; payment?: bigint }>,
) {
  const state = { rolledBack: false, reads: [] as string[][] };
  const changes = Object.entries(rows)
    .flatMap(([id, { origin, payment }]) =>
      [origin, payment].flatMap((height) =>
        height === undefined ? [] : [{ id, height }],
      ),
    )
    .sort((a, b) => Number(a.height - b.height));
  const source = new MessageSource({
    messageHeads: async () =>
      new Map([[1, { head: 10n, indexed: 10n, confirmed: 5n }]]),
    async *messageChanges(_domain, after, through) {
      yield changes.filter((c) => c.height > after[0] && c.height <= through);
    },
    async messageFacts(ids) {
      state.reads.push([...ids]);
      return collectMessageFacts(
        ids.map((id) => {
          const { origin, payment } = rows[id];
          return {
            ...fact(id, String(origin)),
            destination_domain_id: 1,
            origin_tx_id: '1',
            payment_buckets:
              payment === undefined || state.rolledBack
                ? null
                : [
                    {
                      domain: 1,
                      first: String(payment),
                      height: String(payment),
                      count: '1',
                      payment: '1',
                      gas: '1',
                    },
                  ],
          };
        }),
      );
    },
  });
  const frames = (confirmations = 0) => {
    const sent: string[] = [];
    source.subscribe(
      { domains: new Set([1]), confirmations },
      undefined,
      (frame) => {
        const data = frame.data as Record<string, unknown> | undefined;
        sent.push(
          frame.type === 'message_upsert'
            ? `${String(data?.msg_id)}:${String(data?.num_payments)}`
            : String(frame.type),
        );
      },
      assert.fail,
    );
    return sent;
  };
  const rollback = async (from: bigint, to: bigint) => {
    state.rolledBack = true;
    const head = {
      domain: 1,
      confirmedHeight: 5n,
      indexedHeight: to,
      headHeight: to,
      previousIndexedHeight: from,
    };
    source.observe(head);
    source.notify(head);
    for (let i = 0; i < 20; i++) await nextTurn();
  };
  return { source, state, frames, rollback };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await nextTurn();
};

void it('refreshes only rows with a fact above a rollback target', async () => {
  const { source, state, frames, rollback } = rollbackSource({
    old: { origin: 11n },
    new: { origin: 12n, payment: 20n },
  });
  await source.currentHeads();
  const sent = frames();
  advance(source, 1, 11n);
  await settle();
  advance(source, 1, 20n);
  await settle();
  assert.deepEqual(sent, ['old:0', 'new:1']);
  await rollback(20n, 15n);
  assert.deepEqual(sent, ['old:0', 'new:1', 'rollback', 'new:0']);
  assert.deepEqual(state.reads.at(-1), ['new']);
});

void it('keeps a shallow rollback after a large head jump to the removed rows', async () => {
  const { source, state, frames, rollback } = rollbackSource({
    early: { origin: 11n },
    late: { origin: 4000n, payment: 5000n },
  });
  await source.currentHeads();
  const sent = frames();
  advance(source, 1, 5000n);
  await settle();
  assert.deepEqual(sent, ['early:0', 'late:1']);
  await rollback(5000n, 4999n);
  assert.deepEqual(sent, ['early:0', 'late:1', 'rollback', 'late:0']);
  assert.deepEqual(state.reads.at(-1), ['late']);
});

void it('selects rollback refreshes per subscriber', async () => {
  // The payment at 19 is visible at frontier 20 but not at frontier 18.
  const { source, frames, rollback } = rollbackSource({
    paid: { origin: 12n, payment: 19n },
  });
  await source.currentHeads();
  const zero = frames(0),
    two = frames(2);
  advance(source, 1, 20n);
  await settle();
  assert.deepEqual(zero, ['paid:1']);
  assert.deepEqual(two, ['paid:0']);
  await rollback(20n, 15n);
  assert.deepEqual(zero, ['paid:1', 'rollback', 'paid:0']);
  assert.deepEqual(two, ['paid:0', 'rollback']);
});
