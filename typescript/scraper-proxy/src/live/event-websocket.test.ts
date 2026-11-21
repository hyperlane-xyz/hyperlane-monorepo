import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_TYPES,
  confirmationHeight,
  parseClientMessage,
  parseDatabaseDomain,
  parseEventNotification,
  parseExplorerNotification,
  parseExplorerBlocks,
  parseExplorerMessageIds,
  parseExplorerConfirmations,
  parseHeadNotification,
} from './protocol.js';

void describe('event websocket protocol', () => {
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
    for (const confirmations of [
      -1,
      0.1,
      '1',
      null,
      1001,
      Number.MAX_SAFE_INTEGER + 1,
    ])
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

  void it('bounds custom agent retention while retaining canonical fleet subscriptions', () => {
    const parse = (
      domains: number[],
      confirmations?: number,
      confirmationsByDomain?: Record<string, number>,
    ) =>
      parseClientMessage(
        JSON.stringify({
          type: 'subscribe',
          confirmationsByDomain,
          streams: [{ eventType: 'dispatch', domains, confirmations }],
        }),
      );
    const domains = Array.from({ length: 513 }, (_, i) => i + 1);
    assert.doesNotThrow(() => parse(domains));
    assert.doesNotThrow(() => parse(domains.slice(0, 512), 0));
    assert.throws(() => parse(domains, 0), /512/);
    assert.doesNotThrow(() => parse(domains.slice(0, 10), 1000));
    assert.throws(() => parse(domains.slice(0, 11), 1000), /budget/);
    assert.throws(() => parse([1], 0, { 1: 1001 }), /1000/);
    assert.throws(
      () =>
        parse(
          domains.slice(0, 11),
          0,
          Object.fromEntries(
            domains.slice(0, 11).map((domain) => [domain, 1000]),
          ),
        ),
      /budget/,
    );
  });

  void it('accepts optional live block subscriptions alongside events', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [
          { eventType: 'blocks', domains: [1, 42161] },
          { eventType: 'dispatch' },
        ],
      }),
    );
    assert.equal(message.type, 'subscribe');
    if (message.type !== 'subscribe') return;
    assert.deepEqual(message.streams[0], {
      eventType: 'blocks',
      domains: new Set([1, 42161]),
    });
    for (const extra of [
      { confirmations: 0 },
      { domains: [] },
      { domains: [-1] },
    ]) {
      assert.throws(() =>
        parseClientMessage(
          JSON.stringify({
            type: 'subscribe',
            streams: [{ eventType: 'blocks', ...extra }],
          }),
        ),
      );
    }
    assert.equal(parseExplorerBlocks(new URLSearchParams()), false);
    assert.equal(parseExplorerBlocks(new URLSearchParams('blocks=true')), true);
    assert.equal(
      parseExplorerBlocks(new URLSearchParams('blocks=false')),
      false,
    );
    assert.throws(() =>
      parseExplorerBlocks(new URLSearchParams('blocks=oops')),
    );
  });

  void it('parses indexed block hashes without losing large heights', () => {
    const hash = '01ab'.repeat(16);
    const head = {
      domain: 1,
      confirmedHeight: '10',
      headHeight: '9007199254740993',
      indexedHeight: '11',
      indexedHash: hash,
    };
    assert.equal(
      parseHeadNotification(JSON.stringify(head)).indexedHash,
      `0x${hash}`,
    );
    assert.equal(
      parseHeadNotification(JSON.stringify(head)).headHeight,
      9007199254740993n,
    );
    for (const indexedHash of ['bad', null, 123, undefined]) {
      const parsed = parseHeadNotification(
        JSON.stringify({ ...head, indexedHash }),
      );
      assert.equal(parsed.indexedHash, undefined);
      assert.equal(parsed.confirmedHeight, 10n);
      assert.equal(parsed.indexedHeight, 11n);
    }
  });

  void it('accepts application pings', () => {
    assert.deepEqual(parseClientMessage('{"type":"ping"}'), { type: 'ping' });
  });

  void it('rejects duplicate streams', () => {
    assert.throws(
      () =>
        parseClientMessage(
          JSON.stringify({
            type: 'subscribe',
            streams: [{ eventType: 'delivery' }, { eventType: 'delivery' }],
          }),
        ),
      /Duplicate eventType/,
    );
  });

  void it('accepts live gas payment subscriptions', () => {
    const message = parseClientMessage(
      JSON.stringify({
        streams: [{ domains: [1], eventType: 'gas_payment' }],
        type: 'subscribe',
      }),
    );

    assert.equal(message.type, 'subscribe');
    if (message.type !== 'subscribe') return;
    assert.deepEqual(message.streams[0]?.domains, new Set([1]));
  });

  void it('rejects unknown event types and invalid domains', () => {
    for (const stream of [
      { eventType: 'message' },
      { eventType: 'dispatch', domains: [-1] },
    ]) {
      assert.throws(() =>
        parseClientMessage(
          JSON.stringify({ type: 'subscribe', streams: [stream] }),
        ),
      );
    }
  });

  void it('accepts more than 100 domains', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [
          {
            eventType: 'dispatch',
            domains: Array.from({ length: 101 }, (_, domain) => domain),
          },
        ],
      }),
    );

    assert.equal(message.type, 'subscribe');
    if (message.type === 'subscribe') {
      assert.equal(message.streams[0]?.domains?.size, 101);
    }
  });

  void it('parses exact-row database notifications', () => {
    assert.deepEqual(
      parseEventNotification(
        '{"eventType":"merkle_tree_insertion","id":"123","domain":42161}',
      ),
      { domain: 42161, eventType: 'merkle_tree_insertion', id: 123n },
    );
    assert.deepEqual(
      parseEventNotification(
        '{"eventType":"dispatch","id":"124","domain":-846819108}',
      ),
      { domain: 3448148188, eventType: 'dispatch', id: 124n },
    );
    assert.throws(() =>
      parseEventNotification(
        '{"eventType":"unknown","id":"123","domain":42161}',
      ),
    );
    assert.throws(() =>
      parseEventNotification(
        '{"eventType":"dispatch","id":"123","domain":-2147483649}',
      ),
    );
  });

  void it('parses confirmation frontier notifications', () => {
    assert.deepEqual(
      parseHeadNotification(
        '{"domain":42161,"confirmedHeight":"102","previousConfirmedHeight":"99","headHeight":"110","indexedHeight":"108","previousIndexedHeight":"107"}',
      ),
      {
        confirmedHeight: 102n,
        domain: 42161,
        previousConfirmedHeight: 99n,
        headHeight: 110n,
        indexedHeight: 108n,
        indexedHash: undefined,
        previousIndexedHeight: 107n,
      },
    );
  });

  void it('normalizes only valid signed database domain encodings', () => {
    for (const [stored, domain] of [
      [-0x8000_0000, 0x8000_0000],
      [-1, 0xffff_ffff],
      [0, 0],
      [0x7fff_ffff, 0x7fff_ffff],
      [0x8000_0000, 0x8000_0000],
      [0xffff_ffff, 0xffff_ffff],
      ['-2147483648', 0x8000_0000],
      ['4294967295', 0xffff_ffff],
    ] as const) {
      assert.equal(parseDatabaseDomain(stored, 'invalid domain'), domain);
    }
    for (const stored of [
      -0x8000_0001,
      0x1_0000_0000,
      1.5,
      '',
      ' 1',
      '0x1',
      '1e3',
      '1.5',
    ]) {
      assert.throws(
        () => parseDatabaseDomain(stored, 'invalid domain'),
        /invalid domain/,
      );
    }
  });

  void it('parses Explorer message notifications', () => {
    assert.deepEqual(
      parseExplorerNotification(`{"messageId":"${'ab'.repeat(32)}"}`),
      { messageId: `\\x${'ab'.repeat(32)}` },
    );
    assert.throws(() => parseExplorerNotification('{"messageId":"ab"}'));
  });
});

void it('validates optional shared message-ID filters', () => {
  const id = 'ab'.repeat(32);
  assert.equal(parseExplorerMessageIds(new URLSearchParams()), undefined);
  assert.deepEqual(
    parseExplorerMessageIds(new URLSearchParams('messageIds=')),
    new Set(),
  );
  assert.deepEqual(
    parseExplorerMessageIds(
      new URLSearchParams(`messageIds=0x${id},${id.toUpperCase()}`),
    ),
    new Set([`\\x${id}`]),
  );
  assert.throws(() =>
    parseExplorerMessageIds(new URLSearchParams('messageIds=bad')),
  );
  assert.throws(() =>
    parseExplorerMessageIds(
      new URLSearchParams(`messageIds=${Array(51).fill(id).join(',')}`),
    ),
  );
});

void it('validates zero-confirmation opt-in for every event type', () => {
  for (const eventType of EVENT_TYPES) {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [{ eventType, domains: [1], includeZeroConfirmations: true }],
      }),
    );
    assert(message.type === 'subscribe');
    assert.equal(message.streams[0]?.includeZeroConfirmations, true);
  }
  for (const stream of [
    { eventType: 'dispatch', domains: [1], includeZeroConfirmations: 2 },
    { eventType: 'dispatch', includeZeroConfirmations: true },
    { eventType: 'blocks', domains: [1], includeZeroConfirmations: true },
  ])
    assert.throws(() =>
      parseClientMessage(
        JSON.stringify({ type: 'subscribe', streams: [stream] }),
      ),
    );
});

void it('rejects replay options for every agent event stream', () => {
  for (const eventType of [...EVENT_TYPES, 'blocks']) {
    for (const replay of [
      {
        cursors: [
          { domain: 1, address: '0x' + '01'.repeat(20), afterSequence: '-1' },
        ],
      },
      { cursors: [] },
      { cursors: null },
      { streamCursorVersion: 3 },
      { afterId: '1' },
      { afterSequence: '1' },
      { afterStreamCursor: '1' },
      { allowReplay: false },
    ]) {
      assert.throws(
        () =>
          parseClientMessage(
            JSON.stringify({
              type: 'subscribe',
              streams: [{ eventType, domains: [1], ...replay }],
            }),
          ),
        /live-only/,
      );
    }
  }
});
