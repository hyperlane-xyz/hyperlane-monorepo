import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { EventSource } from './event-source.js';
import {
  confirmationHeight,
  type ConfirmationHead,
  type ConfirmationRow,
  type EventType,
  type HeadNotification,
} from './protocol.js';
import type { EventStore } from './event-store.js';

function head(height: bigint, previous = height, domain = 1): HeadNotification {
  return {
    domain,
    headHeight: height,
    indexedHeight: height,
    previousIndexedHeight: previous,
    confirmedHeight: height - 10n,
  };
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await nextTurn();
  }
  assert.fail('source did not reach expected state');
}
function fixture(limits?: { rows: number; bytes: number }) {
  const calls: {
    domain: number;
    after: bigint;
    through: bigint;
    eventType: EventType;
  }[] = [];
  let current = 100n;
  let replacement = false;
  const gates = new Map<number, Promise<void>>();
  const store: Pick<
    EventStore,
    'confirmationSnapshots' | 'confirmationEventRows'
  > = {
    async confirmationSnapshots(policies) {
      return new Map(
        [...policies].map(([count, domains]) => [
          count,
          new Map(
            [...domains].map((domain) => [
              domain,
              { head: current, indexed: current, confirmed: current - 10n },
            ]),
          ),
        ]),
      );
    },
    async *confirmationEventRows(eventType, domain, after, through) {
      calls.push({ domain, after: after[0], through, eventType });
      const orphan = !replacement;
      await gates.get(domain);
      for (let height = after[0] + 1n; height <= through; height++)
        yield {
          position: [height, 0, height],
          message: {
            type: 'event',
            eventType,
            domain,
            height: String(height),
            orphan,
          },
        } satisfies ConfirmationRow;
    },
  };
  const source = new EventSource(store, limits);
  async function subscribe(
    count = 0,
    domains = [1],
    eventType: EventType = 'dispatch',
    send?: (frame: Record<string, unknown>) => boolean,
  ) {
    const frames: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    let active = true;
    const sub = await source.subscribe(
      [{ eventType, domains: new Set(domains), confirmations: count }],
      {
        active: () => active,
        send: (frame) => {
          frames.push(frame);
          return send?.(frame) ?? true;
        },
        fail: (error) => {
          errors.push(error);
          active = false;
        },
      },
    );
    sub.start();
    return {
      ...sub,
      frames,
      errors,
      close: () => {
        active = false;
        sub.stop();
      },
    };
  }
  return {
    source,
    store,
    calls,
    gates,
    subscribe,
    setHead: (height: bigint) => {
      current = height;
    },
    replace: () => {
      replacement = true;
    },
  };
}

void it('shares reads across 100 connections and ten confirmation policies', async () => {
  const f = fixture();
  const subscribers = await Promise.all(
    Array.from({ length: 100 }, (_, i) => f.subscribe(i % 10)),
  );
  assert.equal(f.calls.length, 0, 'subscriptions only take bounded snapshots');
  f.source.notify(head(101n));
  await until(() => subscribers.every((s) => s.frames.length === 1));
  assert.equal(
    f.calls.length,
    2,
    'one retained prefix plus one live extension',
  );
  assert.equal(f.source.metrics().ranges, 1);
  f.calls.length = 0;
  f.source.notify(head(102n));
  await until(() => subscribers.every((s) => s.frames.length === 2));
  assert.equal(
    f.calls.length,
    1,
    'each new height is read once for all policies',
  );
  for (const [index, sub] of subscribers.entries()) {
    assert.deepEqual(
      sub.frames.map((frame) => frame.height),
      [String(101 - (index % 10)), String(102 - (index % 10))],
    );
    assert(sub.frames.every((frame) => frame.confirmations === index % 10));
    sub.close();
  }
  assert.deepEqual(f.source.metrics(), { ranges: 0, rows: 0, bytes: 0 });
});

void it('shares Merkle ranges within one route', async () => {
  const f = fixture();
  const agent = await f.subscribe(0, [1], 'merkle_tree_insertion');
  const frames: Record<string, unknown>[] = [];
  const validator = await f.source.subscribe(
    [
      {
        eventType: 'merkle_tree_insertion',
        domains: new Set([1]),
        confirmations: 0,
      },
    ],
    {
      active: () => true,
      send: (frame) => {
        frames.push(frame);
        return true;
      },
      fail: (error) => assert.fail(String(error)),
    },
  );
  validator.start();
  f.source.notify(head(101n));
  await until(() => agent.frames.length === 1 && frames.length === 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(agent.frames, frames);
  f.source.stop();
});

void it('releases cached rows with rollback coverage and suppresses in-flight orphans', async () => {
  const f = fixture();
  const zero = await f.subscribe();
  const delayed = await f.subscribe(2);
  f.source.notify(head(101n));
  await until(() => zero.frames.length === 1 && delayed.frames.length === 1);
  const blocked = gate();
  f.gates.set(1, blocked.promise);
  f.source.notify(head(102n));
  await until(() => f.calls.some((call) => call.through === 102n));
  f.source.notify(head(99n, 102n));
  assert.equal(zero.frames.at(-1)?.type, 'rollback');
  assert.equal(delayed.frames.at(-1)?.type, 'rollback');
  f.replace();
  f.gates.delete(1);
  blocked.release();
  f.source.notify(head(102n));
  await until(
    () =>
      zero.frames.at(-1)?.height === '102' &&
      delayed.frames.at(-1)?.height === '100',
  );
  for (const sub of [zero, delayed]) {
    const rollback = sub.frames.findIndex((frame) => frame.type === 'rollback');
    assert(
      sub.frames.slice(rollback + 1).every((frame) => frame.orphan === false),
    );
    assert.deepEqual(sub.errors, []);
  }
  f.source.stop();
});

void it('does not let a stalled domain or disconnected subscriber block other readers', async () => {
  const f = fixture();
  const blocked = gate();
  f.gates.set(1, blocked.promise);
  const slow = await f.subscribe();
  const healthy = await f.subscribe(0, [2]);
  f.source.notify(head(101n));
  f.source.notify(head(101n, 100n, 2));
  await until(() => healthy.frames.length === 1);
  assert.equal(slow.frames.length, 0);
  slow.close();
  blocked.release();
  await nextTurn();
  assert.equal(slow.frames.length, 0);
  assert.equal(f.source.metrics().ranges, 1);
  f.source.stop();
});

void it('rejects only an oversized joining prefix and keeps the existing feed alive', async () => {
  const f = fixture({ rows: 4, bytes: 100_000 });
  const healthy = await f.subscribe();
  f.source.notify(head(101n));
  await until(() => healthy.frames.length === 1);
  f.setHead(101n);
  const deep = await f.subscribe(50);
  f.source.notify(head(102n));
  await until(() => deep.errors.length === 1 && healthy.frames.length === 2);
  assert.equal(healthy.frames.at(-1)?.height, '102');
  assert.deepEqual(healthy.errors, []);
  assert.equal(f.source.metrics().ranges, 1);
  await assert.rejects(f.subscribe(50), /temporarily unavailable/);
  const joining = await f.subscribe();
  f.source.notify(head(103n));
  await until(() => joining.frames.some((frame) => frame.height === '103'));
  assert.deepEqual(joining.errors, []);
  f.source.stop();
});

void it('admits a full custom fleet without overflowing the shared read queue', async () => {
  const f = fixture();
  const domains = Array.from({ length: 512 }, (_, i) => i + 1);
  const subscribers = await Promise.all([
    f.subscribe(0, domains, 'dispatch'),
    f.subscribe(0, domains, 'delivery'),
    f.subscribe(0, domains, 'gas_payment'),
    f.subscribe(0, domains, 'merkle_tree_insertion'),
  ]);
  assert.equal(f.source.metrics().ranges, 2048);
  await assert.rejects(f.subscribe(0, [513]), /range capacity/);
  for (const domain of domains) f.source.notify(head(101n, 100n, domain));
  await until(() => subscribers.every((sub) => sub.frames.length === 512));
  assert(subscribers.every((sub) => sub.errors.length === 0));
  assert.equal(f.calls.length, 2048);
  f.source.stop();
});

void it('isolates a failed send from every other subscriber', async () => {
  const f = fixture();
  const failed = await f.subscribe(0, [1], 'dispatch', () => false);
  const healthy = await f.subscribe();
  f.source.notify(head(101n));
  await until(() => healthy.frames.length === 1);
  f.source.notify(head(102n));
  await until(() => healthy.frames.length === 2);
  assert.equal(failed.frames.length, 1);
  assert.deepEqual(healthy.errors, []);
  f.source.stop();
});

void it('keeps agent read capacity available while public-only readers are stalled', async () => {
  const f = fixture();
  const publicSource = fixture();
  const blocked = gate();
  publicSource.gates.set(1, blocked.promise);
  publicSource.gates.set(2, blocked.promise);
  const validators = await Promise.all(
    [1, 2].map((domain) =>
      publicSource.subscribe(0, [domain], 'merkle_tree_insertion'),
    ),
  );
  for (const domain of [1, 2])
    publicSource.source.notify(head(101n, 100n, domain));
  await until(() => publicSource.calls.length === 2);
  const agent = await f.subscribe(0, [1], 'merkle_tree_insertion');
  f.source.notify(head(101n, 100n, 1));
  await until(() => agent.frames.length === 1);
  assert(validators.every((sub) => sub.frames.length === 0));
  blocked.release();
  await until(() => validators.every((sub) => sub.frames.length === 1));
  f.source.stop();
  publicSource.source.stop();
});

void it('sheds the retaining policy under global pressure instead of an unrelated live reader', async () => {
  const f = fixture({ rows: 4, bytes: 100_000 });
  const live = await f.subscribe();
  const retainer = await f.subscribe(4);
  const other = await f.subscribe(0, [2]);
  f.source.notify(head(101n));
  await until(() => live.frames.length === 1 && retainer.frames.length === 1);
  assert.equal(f.source.metrics().rows, 4);
  f.source.notify(head(101n, 100n, 2));
  await until(() => other.frames.length === 1);
  assert.equal(retainer.errors.length, 1);
  assert.deepEqual(live.errors, []);
  assert.deepEqual(other.errors, []);
  f.source.stop();
});

void it('fails only the affected domain on a same-height hash replacement', async () => {
  const f = fixture();
  const affected = await f.subscribe();
  const healthy = await f.subscribe(0, [2]);
  f.source.notify({ ...head(100n), indexedHash: '0x01' });
  f.source.notify({ ...head(100n), indexedHash: '0x02' });
  assert.equal(affected.errors.length, 1);
  assert.deepEqual(healthy.errors, []);
  f.source.notify(head(101n, 100n, 2));
  await until(() => healthy.frames.length === 1);
  f.source.stop();
});

void it('streams the sparse checkpoint gap at startup without waiting for another head', async () => {
  const f = fixture();
  f.store.confirmationSnapshots = async () =>
    new Map([
      [
        0,
        new Map([
          [
            1,
            {
              head: 100n,
              indexed: 100n,
              confirmed: 90n,
              liveStart: {
                height: '98',
                hash: `0x${'ab'.repeat(32)}`,
                contracts: {
                  dispatch: `0x${'11'.repeat(20)}`,
                  delivery: `0x${'11'.repeat(20)}`,
                  gas_payment: `0x${'22'.repeat(20)}`,
                  merkle_tree_insertion: `0x${'33'.repeat(20)}`,
                },
              },
            },
          ],
        ]),
      ],
    ]);
  const sub = await f.subscribe();
  await until(() => sub.frames.length === 2);
  assert.deepEqual(
    sub.frames.map((frame) => frame.height),
    ['99', '100'],
  );
  assert.equal(sub.starts[0].boundary?.height, '98');
  assert.equal(f.calls.length, 1);
  f.source.stop();
});

void it('invalidates handoff and suppresses stale fanout when rollback arrives between send batches', async () => {
  const f = fixture();
  const subs = await Promise.all(
    Array.from({ length: 100 }, () => f.subscribe()),
  );
  f.source.notify(head(101n));
  await until(() => subs.some((sub) => sub.frames.length > 0));
  f.source.notify(head(99n, 101n));
  await nextTurn();
  for (const sub of subs) {
    const rollback = sub.frames.findIndex((frame) => frame.type === 'rollback');
    assert(rollback >= 0);
    assert.equal(
      sub.frames.slice(rollback + 1).some((frame) => frame.type === 'event'),
      false,
    );
    assert.equal(sub.starts[0].boundary, undefined);
  }
  f.source.stop();
});

void it('retries a rolled-back setup snapshot, but not an ordinary advance', async () => {
  for (const rollback of [true, false]) {
    const f = fixture();
    const blocked = gate();
    let reads = 0;
    f.store.confirmationSnapshots = async () => {
      reads++;
      const value: ConfirmationHead = {
        head: reads === 1 ? 100n : 99n,
        indexed: reads === 1 ? 100n : 99n,
        confirmed: 90n,
      };
      if (reads === 1) await blocked.promise;
      return new Map([[0, new Map([[1, value]])]]);
    };
    const pending = f.subscribe();
    await until(() => reads === 1);
    f.source.notify(head(rollback ? 99n : 101n, 100n));
    blocked.release();
    const sub = await pending;
    assert.equal(reads, rollback ? 2 : 1);
    assert.equal(
      sub.frames.some((frame) => frame.type === 'rollback'),
      false,
    );
    if (!rollback) await until(() => sub.frames.at(-1)?.height === '101');
    f.source.stop();
  }
});

void it('does not turn a head-only retreat into a rollback', async () => {
  const f = fixture();
  const sub = await f.subscribe(2);
  f.source.notify(head(101n));
  await until(() => sub.frames.length === 1);
  f.source.notify({ ...head(101n), headHeight: 100n });
  await nextTurn();
  assert.equal(sub.frames.length, 1);
  assert.equal(confirmationHeight({ head: 100n, indexed: 101n }, 2), 98n);
  f.source.stop();
});
