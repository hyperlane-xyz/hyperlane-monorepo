import assert from 'node:assert/strict';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { it } from 'node:test';

import pg from 'pg';

import { DiagnosticsService, openDiagnostics } from './service.js';
import { DiagnosticsStream } from './stream.js';
import type { DiagnosticsFrame } from './types.js';

const messageId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ids = (start: number) =>
  Array.from({ length: 50 }, (_, i) => messageId(start + i));
const requestedIds = (values?: unknown[]): string[] => {
  const value = values?.[0];
  assert(Array.isArray(value));
  assert(value.every((id) => typeof id === 'string'));
  return value;
};

void it('shares the per-IP budget across connections and releases only unused IDs', async (t) => {
  const stream = new DiagnosticsStream(
    new DiagnosticsService({ query: async () => [] }),
  );
  t.after(() => stream.stop());
  const unsubscribe = stream.subscribe('127.0.0.1', ids(1), () => false);
  const duplicate = stream.subscribe('127.0.0.1', ids(1), () => false);
  const extra = [messageId(51)];
  const subscribeExtra = () =>
    stream.subscribe('127.0.0.1', extra, () => false);
  assert.throws(subscribeExtra, /per-IP capacity exceeded/);
  assert.doesNotThrow(() => stream.subscribe('127.0.0.2', extra, () => false));
  unsubscribe();
  assert.throws(subscribeExtra, /per-IP capacity exceeded/);
  duplicate();
  assert.doesNotThrow(subscribeExtra);
});

void it('preserves the global budget while allowing overlapping subscriptions', async (t) => {
  const stream = new DiagnosticsStream(
    new DiagnosticsService({ query: async () => [] }),
  );
  t.after(() => stream.stop());
  const unsubscribe = stream.subscribe('127.0.0.1', ids(1), () => false);
  for (let i = 1; i < 4; i++)
    stream.subscribe(`127.0.0.${i + 1}`, ids(1 + i * 50), () => false);
  const extra = () =>
    stream.subscribe('127.0.0.5', [messageId(201)], () => false);
  assert.throws(extra, /subscription capacity exceeded/);
  assert.doesNotThrow(() =>
    stream.subscribe('127.0.0.5', [messageId(200)], () => false),
  );
  unsubscribe();
  assert.doesNotThrow(extra);
});

void it('coalesces notifications and reads only affected watched messages', async (t) => {
  const reads: string[][] = [];
  let notify = (_payload: string) => {};
  const service = new DiagnosticsService(
    {
      query: async (_sql, values) => {
        reads.push(requestedIds(values));
        return [];
      },
    },
    async (next) => {
      notify = next;
      return async () => undefined;
    },
  );
  const stream = new DiagnosticsStream(service, 0);
  t.after(() => stream.stop());
  stream.start();
  await setImmediate();
  const frames: DiagnosticsFrame[] = [];
  stream.subscribe(
    '127.0.0.1',
    [messageId(1), messageId(2)],
    (frame, complete) => {
      frames.push(frame);
      complete(true);
      return true;
    },
  );
  await stream.flush();
  assert.deepEqual(reads, [[messageId(1).slice(2), messageId(2).slice(2)]]);
  reads.length = 0;
  notify(messageId(2).slice(2));
  notify(messageId(2).slice(2));
  notify(messageId(3).slice(2));
  notify('invalid');
  await stream.flush();
  assert.deepEqual(reads, [[messageId(2).slice(2)]]);
  assert.equal(frames.length, 2); // Initial snapshots only; unchanged update suppressed.
});

void it('rotates changing snapshots fairly and shares encoded frame inputs', async (t) => {
  let generation = 0;
  const watched = [messageId(1), messageId(2)];
  const service = new DiagnosticsService({
    query: async (_sql, values) => {
      generation++;
      return requestedIds(values).map((hex, index) => ({
        id: String(generation * 10 + index),
        message_id: `0x${hex}`,
        relayer: messageId(9),
        origin: 1,
        destination: 2,
        observed_at: `2026-11-05T00:00:0${generation}Z`,
        received_at: `2026-11-05T00:00:0${generation}Z`,
        version: 1,
        activity: { type: 'future_event', generation },
      }));
    },
  });
  const stream = new DiagnosticsStream(service, 0, 1);
  t.after(() => stream.stop());
  const received = Array.from({ length: 3 }, () => new Set<string>());
  const firstFrames: DiagnosticsFrame[] = [];
  let remaining = 2;
  for (let subscriber = 0; subscriber < received.length; subscriber++)
    stream.subscribe(
      `127.0.0.${subscriber + 1}`,
      watched,
      (frame, complete) => {
        if (frame.type !== 'diagnostics') {
          complete(true);
          return true;
        }
        if (generation === 1) firstFrames.push(frame);
        const sent = subscriber > 0 && remaining > 0;
        if (sent) {
          remaining--;
          received[subscriber]?.add(frame.data.message_id);
        }
        complete(sent);
        return sent;
      },
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    remaining = 2;
    await stream.flush();
  }
  const firstIdFrames = firstFrames.filter(
    (frame) =>
      frame.type === 'diagnostics' && frame.data.message_id === watched[0],
  );
  assert.equal(firstIdFrames.length, 3);
  assert(firstIdFrames.every((frame) => frame === firstIdFrames[0]));
  assert.equal(received[0]?.size, 0);
  assert(received.slice(1).every((ids) => ids.size === watched.length));
});

void it('marks disconnects unavailable, reconnects, and repairs missed wakeups', async (t) => {
  let disconnect = () => {};
  let connections = 0;
  let reads = 0;
  const service = new DiagnosticsService(
    {
      query: async () => {
        reads++;
        return [];
      },
    },
    async (_notify, lost) => {
      connections++;
      disconnect = lost;
      return async () => undefined;
    },
  );
  const stream = new DiagnosticsStream(service, 0, 1);
  t.after(() => stream.stop());
  const frames: DiagnosticsFrame[] = [];
  stream.subscribe('127.0.0.1', [messageId(1)], (frame, complete) => {
    frames.push(frame);
    complete(true);
    return true;
  });
  stream.start();
  await setImmediate();
  await stream.flush();
  assert.equal(reads, 1);
  disconnect();
  assert.equal(frames.at(-1)?.type, 'diagnostics_unavailable');
  await setTimeout(5);
  await stream.flush();
  assert.equal(connections, 2);
  assert.equal(reads, 2);
  assert.equal(frames.at(-1)?.type, 'diagnostics');
});

void it('reconnects when a listener disconnects before setup settles', async (t) => {
  let connections = 0;
  let disconnect = () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new DiagnosticsService(
    { query: async () => [] },
    async (_notify, lost) => {
      connections++;
      disconnect = lost;
      if (connections === 1) await held;
      return async () => undefined;
    },
  );
  const stream = new DiagnosticsStream(service, 0, 1);
  t.after(() => stream.stop());
  stream.start();
  await setImmediate();
  disconnect();
  release();
  await setTimeout(5);
  assert.equal(connections, 2);
});

void it('lets healthy recovery supersede a delayed unavailable frame', async (t) => {
  const disconnects: (() => void)[] = [];
  const service = new DiagnosticsService(
    { query: async () => [] },
    async (_notify, disconnect) => {
      disconnects.push(disconnect);
      return async () => undefined;
    },
  );
  const stream = new DiagnosticsStream(service, 0, 1);
  t.after(() => stream.stop());
  const frames: DiagnosticsFrame[] = [];
  let completeUnavailable = (_sent: boolean) => {};
  stream.subscribe('127.0.0.1', [messageId(1)], (frame, complete) => {
    frames.push(frame);
    if (frame.type === 'diagnostics_unavailable')
      completeUnavailable = complete;
    else complete(true);
    return true;
  });
  stream.start();
  await setImmediate();
  await stream.flush();
  disconnects[0]?.();
  await setTimeout(5);
  await stream.flush();
  completeUnavailable(true);
  assert.deepEqual(
    frames.map(({ type }) => type),
    ['diagnostics', 'diagnostics_unavailable', 'diagnostics'],
  );
});

void it('fails a silent listener after its health query times out', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const queries: string[] = [];
  t.mock.method(pg.Client.prototype, 'connect', async () => {});
  t.mock.method(pg.Client.prototype, 'query', async (sql: string) => {
    queries.push(sql);
    if (sql === 'SELECT 1') throw new Error('listener timed out');
    return { rows: [] };
  });
  t.mock.method(pg.Client.prototype, 'end', async () => {});
  t.mock.method(pg.Pool.prototype, 'end', async () => {});
  const db = openDiagnostics('postgresql://unused:unused@localhost/unused');
  let disconnects = 0;
  const stop = await db.service.listen?.(
    () => {},
    () => disconnects++,
  );
  assert(stop);
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.deepEqual(queries, ['LISTEN message_activity_insert', 'SELECT 1']);
  assert.equal(disconnects, 1);
  await stop();
  await db.close();
});

void it('retries affected snapshots and outages until their writes succeed', async (t) => {
  let broken = false;
  let notify = (_payload: string) => {};
  const stream = new DiagnosticsStream(
    new DiagnosticsService(
      {
        query: async () => {
          if (broken) throw new Error('database unavailable');
          return [];
        },
      },
      async (next) => {
        notify = next;
        return async () => undefined;
      },
    ),
    0,
    1,
  );
  t.after(() => stream.stop());
  stream.start();
  await setImmediate();
  const attempts: DiagnosticsFrame[] = [];
  let accept = false;
  stream.subscribe('127.0.0.1', [messageId(1)], (frame, complete) => {
    attempts.push(frame);
    complete(accept);
    return accept;
  });
  await stream.flush();
  assert.equal(attempts.length, 1);
  accept = true;
  await stream.flush();
  assert.deepEqual(attempts[1], attempts[0]);
  broken = true;
  accept = false;
  notify(messageId(1).slice(2));
  await stream.flush();
  assert.equal(attempts.at(-1)?.type, 'diagnostics_unavailable');
  accept = true;
  await stream.flush();
  broken = false;
  await stream.flush();
  assert.equal(attempts.at(-1)?.type, 'diagnostics');
});
