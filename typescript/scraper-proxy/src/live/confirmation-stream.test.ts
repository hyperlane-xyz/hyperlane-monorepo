import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  ConfirmationStream,
  confirmationHeight,
  type ConfirmationRow,
  type Position,
} from './confirmation-stream.js';
import {
  parseClientMessage,
  parseExplorerConfirmations,
  type HeadNotification,
  type LiveStartBoundary,
} from './protocol.js';

function head(
  indexed: bigint,
  previous = indexed,
  height = indexed,
  domain = 1,
): HeadNotification {
  return {
    domain,
    confirmedHeight: 0n,
    indexedHeight: indexed,
    previousIndexedHeight: previous,
    headHeight: height,
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
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('reader did not reach expected state');
}
async function fixture(
  read: (
    domain: number,
    after: Position,
    through: bigint,
  ) => AsyncIterable<ConfirmationRow>,
  send?: () => Promise<void>,
) {
  const domains = new Set([1, 2]);
  const messages: Record<string, unknown>[] = [];
  let active = true;
  const stream = new ConfirmationStream(0, domains, {
    active: () => active,
    read,
    send: async (message) => {
      messages.push(message);
      await send?.();
      return active;
    },
    rollback: (domain, from, to) =>
      messages.push({ type: 'rollback', domain, from, to }),
    fail: (error) => {
      active = false;
      assert.fail(String(error));
    },
  });
  await stream.initialize(
    async () =>
      new Map(
        [...domains].map((domain) => [
          domain,
          { head: 9n, indexed: 9n, confirmed: 0n },
        ]),
      ),
  );
  stream.start();
  return {
    stream,
    messages,
    stop: () => {
      active = false;
    },
  };
}

void it('uses the lower of indexed progress and head minus confirmations', () => {
  assert.equal(confirmationHeight({ head: 20n, indexed: 18n }, 5), 15n);
  assert.equal(confirmationHeight({ head: 20n, indexed: 12n }, 5), 12n);
});

void it('validates live-only confirmations on both endpoints', () => {
  const parse = (fields: Record<string, unknown>) =>
    parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [{ eventType: 'dispatch', ...fields }],
      }),
    );
  assert.doesNotThrow(() => parse({ confirmations: 0, domains: [1] }));
  for (const confirmations of [-1, 0.1, '1', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parse({ confirmations, domains: [1] }));
  assert.throws(() => parse({ confirmations: 0 }));
  assert.deepEqual(
    parseExplorerConfirmations(
      new URLSearchParams('confirmations=2&domains=1,2'),
    ),
    { confirmations: 2, domains: new Set([1, 2]) },
  );
  for (const url of [
    '?confirmations=0',
    '?domains=1',
    '?confirmations=-1&domains=1',
    '?confirmations=0&domains=',
    '?confirmations=1001&domains=1',
    `?confirmations=1000&domains=${Array.from({ length: 11 }, (_, i) => i + 1).join(',')}`,
    `?confirmations=0&domains=${Array.from({ length: 513 }, (_, i) => i).join(',')}`,
  ])
    assert.throws(() => parseExplorerConfirmations(new URLSearchParams(url)));
});

for (const pause of ['read', 'send']) {
  void it(`rewinds an in-flight ${pause} and delivers replacements after a head drop`, async () => {
    const held = gate();
    let reads = 0;
    let orphan = true;
    const f = await fixture(
      async function* () {
        reads++;
        const data = orphan ? 'orphan' : 'replacement';
        if (pause === 'read' && orphan) await held.promise;
        yield { position: [10n, 0, 1n], message: { data } };
      },
      async () => {
        if (pause === 'send' && orphan) await held.promise;
      },
    );
    try {
      f.stream.notify(head(10n, 9n));
      await until(() =>
        pause === 'read' ? reads === 1 : f.messages.length === 1,
      );
      f.stream.notify(head(9n, 10n));
      assert.deepEqual(f.messages.at(-1), {
        type: 'rollback',
        domain: 1,
        from: 10n,
        to: 9n,
      });
      orphan = false;
      f.stream.notify(head(10n, 9n));
      held.release();
      await until(() => f.messages.some((m) => m.data === 'replacement'));
      assert.equal(
        f.messages.filter((m) => m.data === 'orphan').length,
        pause === 'read' ? 0 : 1,
      );
    } finally {
      f.stop();
      held.release();
    }
  });
}

for (const rollbackDomain of [1, 2]) {
  void it(`resumes within a height after domain ${rollbackDomain} rolls back mid-page`, async () => {
    const held = gate();
    let reads = 0;
    const f = await fixture(async function* (domain, after) {
      if (domain !== 1) return;
      reads++;
      for (const id of [1n, 2n]) {
        if (after[0] === 10n && after[2] >= id) continue;
        if (reads === 1 && id === 2n) await held.promise;
        yield { position: [10n, 0, id], message: { id: String(id) } };
      }
    });
    try {
      f.stream.notify(head(10n, 9n));
      await until(() => f.messages.length === 1);
      f.stream.notify(
        rollbackDomain === 1 ? head(10n, 11n) : head(8n, 9n, 8n, 2),
      );
      held.release();
      await until(() => f.messages.some((m) => m.id === '2'));
      assert.deepEqual(
        f.messages.filter((m) => m.id).map((m) => m.id),
        ['1', '2'],
      );
    } finally {
      f.stop();
      held.release();
    }
  });
}

void it('coalesces advancing heads and does not treat a head-only drop as a fork', async () => {
  const held = gate();
  const ranges: bigint[] = [];
  const f = await fixture(async function* (_domain, _after, through) {
    ranges.push(through);
    if (through === 10n) await held.promise;
    yield { position: [through, 0, 1n], message: { height: through } };
  });
  try {
    f.stream.notify(head(10n, 9n));
    await until(() => ranges.length === 1);
    f.stream.notify(head(11n, 10n));
    f.stream.notify(head(12n, 11n));
    held.release();
    await until(() => f.messages.length === 2);
    f.stream.notify(head(12n, 12n, 11n));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(ranges, [10n, 12n]);
    assert.equal(
      f.messages.some((m) => m.type === 'rollback'),
      false,
    );
  } finally {
    f.stop();
    held.release();
  }
});

void it('retries negotiation if a rollback arrives during the initial read', async () => {
  const held = gate();
  let reads = 0;
  const stream = new ConfirmationStream(0, new Set([1]), {
    active: () => true,
    read: () => {
      assert.fail('not started');
    },
    send: async () => true,
    rollback: () => assert.fail('no initial frames to roll back'),
    fail: (error) => assert.fail(String(error)),
  });
  const initializing = stream.initialize(async () => {
    reads++;
    const liveStart = boundary(reads === 1 ? 10n : 9n);
    if (reads === 1) await held.promise;
    return new Map([[1, { head: 9n, indexed: 9n, confirmed: 0n, liveStart }]]);
  });
  stream.notify(head(9n, 10n));
  held.release();
  await initializing;
  assert.equal(reads, 2);
  assert.deepEqual(stream.liveStart(1), boundary(9n));
});

void it('does not retry negotiation for an advancing head or emit rollback before start', async () => {
  const held = gate();
  let reads = 0;
  const stream = new ConfirmationStream(0, new Set([1]), {
    active: () => true,
    read: async function* () {},
    send: async () => assert.fail('not started'),
    rollback: () => assert.fail('not started'),
    fail: (error) => assert.fail(String(error)),
  });
  const initializing = stream.initialize(async () => {
    reads++;
    await held.promise;
    return new Map([[1, { head: 9n, indexed: 9n, confirmed: 0n }]]);
  });
  stream.notify(head(10n, 9n));
  held.release();
  await initializing;
  assert.equal(reads, 1);
  stream.notify(head(8n, 9n));
});

void it('retains the exposed snapshot height when a head-only drop interrupts a page', async () => {
  const held = gate();
  let reads = 0;
  const f = await fixture(async function* () {
    reads++;
    if (reads === 1) {
      yield { position: [10n, 0, 1n], message: { height: 11n } };
      await held.promise;
    }
  });
  try {
    f.stream.notify(head(11n, 9n));
    await until(() => f.messages.length === 1);
    f.stream.notify(head(11n, 11n, 10n));
    f.stream.notify(head(8n, 9n, 8n, 2));
    held.release();
    await until(() => reads === 2);
    f.stream.notify(head(10n, 11n));
    assert.deepEqual(f.messages.at(-1), {
      type: 'rollback',
      domain: 1,
      from: 11n,
      to: 10n,
    });
  } finally {
    f.stop();
    held.release();
  }
});

function boundary(height: bigint): LiveStartBoundary {
  return {
    height: height.toString(),
    hash: `0x${'ab'.repeat(32)}`,
    contracts: {
      dispatch: 'mailbox',
      delivery: 'mailbox',
      merkle_tree_insertion: 'merkle',
      gas_payment: 'igp',
    },
  };
}

void it('starts at the custom checkpoint, preserves it across advances and invalidates it on rollback', async () => {
  const ranges: bigint[][] = [];
  const rollbacks: bigint[][] = [];
  const stream = new ConfirmationStream(2, new Set([1]), {
    active: () => true,
    read: async function* (_domain, after, through) {
      ranges.push([after[0], through]);
      yield* [];
    },
    send: async () => true,
    rollback: (_domain, from, to) => {
      rollbacks.push([from, to]);
    },
    fail: (error) => assert.fail(String(error)),
  });
  await stream.initialize(
    async () =>
      new Map([
        [
          1,
          {
            head: 112n,
            indexed: 110n,
            confirmed: 100n,
            liveStart: boundary(108n),
          },
        ],
      ]),
  );
  // A sparse checkpoint is below the numerical frontier. The live reader must
  // cover this interval instead of skipping directly to head-confirmations.
  stream.start();
  await until(() => ranges.length === 1);
  assert.deepEqual(ranges[0], [108n, 110n]);
  stream.notify(head(113n, 110n, 114n));
  await until(() => ranges.length === 2);
  assert.deepEqual(ranges[1], [110n, 112n]);
  assert.deepEqual(stream.liveStart(1), boundary(108n));
  stream.notify(head(105n, 113n, 110n));
  assert.equal(stream.liveStart(1), undefined);
  assert.deepEqual(rollbacks, [[112n, 105n]]);
});

void it('invalidates a boundary if another stream is negotiating during a rollback', async () => {
  const stream = new ConfirmationStream(0, new Set([1]), {
    active: () => true,
    read: () => assert.fail('not started'),
    send: async () => assert.fail('not started'),
    rollback: () => assert.fail('not started'),
    fail: (error) => assert.fail(String(error)),
  });
  await stream.initialize(
    async () =>
      new Map([
        [
          1,
          {
            head: 10n,
            indexed: 10n,
            confirmed: 5n,
            liveStart: boundary(10n),
          },
        ],
      ]),
  );
  stream.notify(head(9n, 10n));
  assert.equal(stream.liveStart(1), undefined);
});
