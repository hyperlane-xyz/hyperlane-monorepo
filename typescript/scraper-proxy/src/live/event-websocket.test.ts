import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseClientMessage, parseEventNotification } from './protocol.js';

describe('event websocket protocol', () => {
  it('parses multiplexed resumable subscriptions', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'subscribe',
        streams: [
          {
            eventType: 'dispatch',
            domains: [1, 42161, 1],
            afterId: '9007199254740993',
          },
          { eventType: 'merkle_tree_insertion' },
        ],
      }),
    );

    assert.equal(message.type, 'subscribe');
    if (message.type !== 'subscribe') return;
    assert.equal(message.streams[0]?.afterId, 9_007_199_254_740_993n);
    assert.deepEqual(message.streams[0]?.domains, new Set([1, 42161]));
    assert.equal(message.streams[1]?.afterId, undefined);
  });

  it('accepts application pings', () => {
    assert.deepEqual(parseClientMessage('{"type":"ping"}'), { type: 'ping' });
  });

  it('rejects duplicate streams', () => {
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

  it('rejects unsafe numeric cursors', () => {
    assert.throws(
      () =>
        parseClientMessage(
          JSON.stringify({
            type: 'subscribe',
            streams: [
              {
                eventType: 'gas_payment',
                afterId: Number.MAX_SAFE_INTEGER + 1,
              },
            ],
          }),
        ),
      /afterId/,
    );
  });

  it('rejects unknown event types and invalid domains', () => {
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

  it('accepts more than 100 domains', () => {
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

  it('parses exact-row database notifications', () => {
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
});
