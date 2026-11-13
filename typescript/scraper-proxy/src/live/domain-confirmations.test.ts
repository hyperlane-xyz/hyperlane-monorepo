import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  EVENT_TYPES,
  parseClientMessage,
  splitConfirmationStreams,
} from './protocol.js';

function subscribe(confirmationsByDomain: unknown, streams: unknown[]) {
  const message = parseClientMessage(
    JSON.stringify({ type: 'subscribe', confirmationsByDomain, streams }),
  );
  assert(message.type === 'subscribe');
  return message;
}

void it('domain overrides take precedence for every event type, including zero', () => {
  for (const eventType of EVENT_TYPES) {
    for (const confirmations of [undefined, 12]) {
      const message = subscribe({ 1: 0, 2: 3, 9: 99 }, [
        { eventType, domains: [1, 2, 3, 4], confirmations },
      ]);
      const request = message.streams[0];
      assert(request && request.eventType !== 'blocks');
      const groups = splitConfirmationStreams(
        request,
        message.confirmationsByDomain,
      );
      assert.deepEqual(
        groups.map((group) => ({
          confirmations: group.confirmations,
          domains: [...(group.domains ?? [])],
        })),
        [
          { confirmations: 0, domains: [1] },
          { confirmations: 3, domains: [2] },
          { confirmations, domains: [3, 4] },
        ],
      );
      assert.deepEqual([...(request.domains ?? [])], [1, 2, 3, 4]);
      assert(groups.every((group) => group.eventType === eventType));
    }
  }
});

void it('omitted or empty domain overrides retain legacy subscriptions', () => {
  for (const confirmationsByDomain of [undefined, {}]) {
    for (const stream of [
      { eventType: 'dispatch' },
      { eventType: 'dispatch', domains: [1], confirmations: 2 },
    ]) {
      const message = subscribe(confirmationsByDomain, [stream]);
      const request = message.streams[0];
      assert(request && request.eventType !== 'blocks');
      assert.deepEqual(
        splitConfirmationStreams(request, message.confirmationsByDomain),
        [request],
      );
    }
  }
});

void it('supports the full uint32 domain range and leaves block streams unchanged', () => {
  const message = subscribe({ 0: 0, 4294967295: 5 }, [
    { eventType: 'dispatch', domains: [0, 4294967295] },
    { eventType: 'blocks' },
  ]);
  assert.deepEqual(
    message.confirmationsByDomain,
    new Map([
      [0, 0],
      [4294967295, 5],
    ]),
  );
  assert.deepEqual(message.streams[1], {
    eventType: 'blocks',
    domains: undefined,
  });
});

void it('rejects malformed domain maps and confirmation values', () => {
  for (const value of [
    null,
    [],
    1,
    '1',
    { '-1': 2 },
    { '4294967296': 2 },
    { '01': 2 },
    { '1.5': 2 },
    { '1e3': 2 },
    { '': 2 },
  ]) {
    assert.throws(() =>
      subscribe(value, [{ eventType: 'dispatch', domains: [1] }]),
    );
  }
  assert.throws(() =>
    parseClientMessage(
      '{"type":"subscribe","confirmationsByDomain":{"__proto__":2},"streams":[{"eventType":"dispatch","domains":[1]}]}',
    ),
  );
  for (const value of [null, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => subscribe({ 1: value }, [{ eventType: 'dispatch', domains: [1] }]),
      /confirmations/,
    );
  }
});

void it('requires explicit domains and preserves live-only custom confirmation rules', () => {
  assert.throws(
    () =>
      splitConfirmationStreams({ eventType: 'dispatch' }, new Map([[1, 2]])),
    /explicit/,
  );
  assert.throws(
    () => subscribe({ 1: 2 }, [{ eventType: 'dispatch' }]),
    /explicit/,
  );
  const replay = {
    eventType: 'dispatch',
    cursors: [
      { domain: 1, address: `0x${'11'.repeat(20)}`, afterSequence: '0' },
    ],
  };
  assert.throws(() => subscribe({ 1: 0 }, [replay]), /live streams only/);
  const message = subscribe({ 2: 0 }, [replay]);
  const request = message.streams[0];
  assert(request && request.eventType !== 'blocks');
  assert.equal(
    splitConfirmationStreams(request, message.confirmationsByDomain)[0]?.cursors
      ?.length,
    1,
  );
});
