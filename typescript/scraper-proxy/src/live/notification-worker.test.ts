import assert from 'node:assert/strict';
import { it } from 'node:test';

import { NotificationWorker } from './notification-worker.js';

void it('coalesces notifications and flushes without overlapping an active drain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const worker = new NotificationWorker(
    10,
    async () => {
      calls++;
      if (calls === 1) await blocked;
    },
    assert.fail,
  );
  t.after(() => worker.stop());

  worker.schedule();
  worker.schedule();
  t.mock.timers.tick(9);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  const running = worker.flush();
  assert.equal(worker.flush(), running);
  worker.schedule();
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  release();
  await running;
  t.mock.timers.tick(10);
  await worker.flush();
  assert.equal(calls, 2, 'notification during the read is not lost');

  worker.schedule();
  worker.stop();
  t.mock.timers.tick(100);
  await worker.flush();
  assert.equal(calls, 2, 'shutdown cancels queued work');
});

void it('lets a failed drain request a delayed retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const failure = new Error('database unavailable');
  const worker = new NotificationWorker(
    10,
    async () => {
      if (++calls === 1) throw failure;
    },
    (error) => {
      assert.equal(error, failure);
      worker.schedule(50);
    },
  );
  t.after(() => worker.stop());

  await worker.flush();
  t.mock.timers.tick(49);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await worker.flush();
  assert.equal(calls, 2);
});

void it('keeps scheduling when a drain schedules before its first await', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const worker = new NotificationWorker(
    10,
    async () => {
      if (++calls === 1) {
        worker.schedule();
        await blocked;
      }
    },
    assert.fail,
  );
  t.after(() => worker.stop());
  const running = worker.flush();
  t.mock.timers.tick(10);
  assert.equal(calls, 1);
  release();
  await running;
  t.mock.timers.tick(10);
  assert.equal(
    calls,
    2,
    'the timer fired during the drain must not block its retry',
  );
});
