import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseClientMessage,
  parseEventNotification,
  parseExplorerNotification,
} from './protocol.js';

void describe('event websocket protocol', () => {
  void it('parses native sequence catch-up cursors', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [
          {
            eventType: 'dispatch',
            cursors: [
              {
                address: '0x0000000000000000000000000000000000000001',
                afterSequence: '9007199254740993',
                domain: 1,
              },
              {
                address: '\\x0000000000000000000000000000000000000002',
                domain: 42161,
              },
            ],
          },
          { eventType: 'merkle_tree_insertion' },
        ],
      }),
    );

    assert.equal(message.type, 'subscribe');
    if (message.type !== 'subscribe') return;
    assert.equal(
      message.streams[0]?.cursors?.[0]?.afterSequence,
      9_007_199_254_740_993n,
    );
    assert.equal(
      message.streams[0]?.cursors?.[0]?.address,
      '\\x0000000000000000000000000000000000000001',
    );
    assert.deepEqual(message.streams[0]?.domains, new Set([1, 42161]));
    assert.equal(message.streams[1]?.cursors, undefined);
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

  void it('rejects row ID cursors and cursors on unsequenced streams', () => {
    for (const stream of [
      { eventType: 'dispatch', afterId: '1' },
      {
        eventType: 'gas_payment',
        cursors: [
          {
            address: '0x0000000000000000000000000000000000000001',
            afterSequence: '1',
            domain: 1,
          },
        ],
      },
    ]) {
      assert.throws(() =>
        parseClientMessage(
          JSON.stringify({ type: 'subscribe', streams: [stream] }),
        ),
      );
    }
  });

  void it('requires explicit domains to match cursor domains', () => {
    assert.throws(
      () =>
        parseClientMessage(
          JSON.stringify({
            type: 'subscribe',
            streams: [
              {
                eventType: 'dispatch',
                domains: [1, 42161],
                cursors: [
                  {
                    address: '0x0000000000000000000000000000000000000001',
                    domain: 1,
                  },
                ],
              },
            ],
          }),
        ),
      /exactly match/,
    );
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
    assert.throws(() =>
      parseEventNotification(
        '{"eventType":"unknown","id":"123","domain":42161}',
      ),
    );
  });

  void it('parses Explorer message notifications', () => {
    assert.deepEqual(
      parseExplorerNotification(`{"messageId":"${'ab'.repeat(32)}"}`),
      { messageId: `\\x${'ab'.repeat(32)}` },
    );
    assert.throws(() => parseExplorerNotification('{"messageId":"ab"}'));
  });
});
