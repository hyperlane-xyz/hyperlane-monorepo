import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  ConfirmationUnavailableError,
  confirmationHeight,
  endOfHeight,
  type ConfirmationRow,
  type Position,
  type EventType,
  type HeadNotification,
  type LiveStartBoundary,
} from './protocol.js';
import type { EventStore } from './event-store.js';

const END_POSITION = endOfHeight(0n);

type Request = {
  eventType: EventType;
  confirmations: number;
  domains: Set<number>;
  allowUnavailable?: boolean;
};
type Subscriber = {
  active: () => boolean;
  send: (message: Record<string, unknown>) => boolean;
  fail: (error: unknown) => void;
  started: boolean;
  cursors: Cursor[];
};
type Cursor = {
  owner: Subscriber;
  eventType: EventType;
  domain: number;
  confirmations: number;
  boundary?: LiveStartBoundary;
  position: Position;
  target: bigint;
  exposed: bigint;
};
type CachedRow = ConfirmationRow & { bytes: number };
type Window = {
  key: string;
  eventType: EventType;
  domain: number;
  cursors: Set<Cursor>;
  floor: bigint;
  through: bigint;
  rows: CachedRow[];
  bytes: number;
  revision: number;
  running: boolean;
};
type Limits = { rows: number; bytes: number; parallel: number; ranges: number };
class CapacityError extends Error {
  constructor() {
    super('Event source retained range limit exceeded');
  }
}

/** One retained range per domain/event type. Connections own release cursors,
 * never readers. Each route owns an isolated instance of this implementation. */
export class EventSource {
  private readonly windows = new Map<string, Window>();
  private readonly heads = new Map<
    number,
    { version: number; head: HeadNotification }
  >();
  private readonly retryAfter = new Map<
    string,
    { until: number; confirmations: number }
  >();
  private readonly publications = new Set<Promise<void>>();
  private running = 0;
  private readonly limits: Limits;
  private version = 0;
  private revision = 0;
  private stopped = false;
  private bytes = 0;
  private rows = 0;
  private pendingBytes = 0;
  private pendingRows = 0;

  constructor(
    private readonly store: Pick<
      EventStore,
      'confirmationSnapshots' | 'confirmationEventRows'
    >,
    limits: Partial<Limits> = {},
  ) {
    this.limits = {
      rows: 10_000,
      bytes: 32 * 1024 * 1024,
      parallel: 4,
      ranges: 2048,
      ...limits,
    };
  }

  metrics() {
    return {
      ranges: this.windows.size,
      rows: this.rows + this.pendingRows,
      bytes: this.bytes + this.pendingBytes,
    };
  }

  async subscribe(
    requests: Request[],
    io: Pick<Subscriber, 'active' | 'send' | 'fail'>,
  ) {
    const owner: Subscriber = { ...io, started: false, cursors: [] };
    const policies = new Map<number, Set<number>>();
    for (const request of requests) {
      const domains = policies.get(request.confirmations) ?? new Set<number>();
      for (const domain of request.domains) domains.add(domain);
      policies.set(request.confirmations, domains);
    }
    while (policies.size && io.active() && !this.stopped) {
      const revision = this.revision;
      const version = this.version;
      const snapshots = await this.store.confirmationSnapshots(policies);
      if (!io.active() || this.stopped) break;
      if (revision !== this.revision) continue;
      // Validate the entire negotiation before attaching any cursors.
      const newRanges = new Set<string>();
      for (const request of requests)
        for (const domain of request.domains) {
          const head = snapshots.get(request.confirmations)?.get(domain);
          if (!head && !request.allowUnavailable)
            throw new ConfirmationUnavailableError(domain);
          const key = `${request.eventType}:${domain}`;
          const retry = this.retryAfter.get(key);
          if (
            retry &&
            retry.until > Date.now() &&
            request.confirmations >= retry.confirmations
          )
            throw new Error('Event source temporarily unavailable');
          if (head && !this.windows.has(key)) newRanges.add(key);
        }
      if (this.windows.size + newRanges.size > this.limits.ranges)
        throw new Error('Event source range capacity exceeded');
      for (const request of requests)
        for (const domain of request.domains) {
          const head = snapshots.get(request.confirmations)?.get(domain);
          const target = head
            ? confirmationHeight(head, request.confirmations)
            : 0n;
          const height = head?.liveStart
            ? BigInt(head.liveStart.height)
            : target;
          const cursor: Cursor = {
            owner,
            eventType: request.eventType,
            domain,
            confirmations: request.confirmations,
            boundary: head?.liveStart,
            position: endOfHeight(height),
            target,
            exposed: height,
          };
          owner.cursors.push(cursor);
          if (!head) continue; // Advisory coverage is fixed until reconnect.
          const observed = this.heads.get(domain);
          if (observed && observed.version > version)
            this.update(cursor, observed.head);
          const key = `${request.eventType}:${domain}`;
          let window = this.windows.get(key);
          if (!window) {
            window = {
              key,
              eventType: request.eventType,
              domain,
              cursors: new Set(),
              floor: height,
              through: height,
              rows: [],
              bytes: 0,
              revision: 0,
              running: false,
            };
            this.windows.set(key, window);
          }
          window.cursors.add(cursor);
        }
      break;
    }
    return {
      starts: owner.cursors,
      start: () => {
        if (!io.active() || this.stopped) return;
        owner.started = true;
        this.scheduleAvailable();
      },
      stop: () => this.remove(owner),
    };
  }

  notify(head: HeadNotification) {
    if (head.headHeight === undefined || head.indexedHeight === undefined)
      return;
    const previous = this.heads.get(head.domain)?.head;
    const replaced =
      previous?.indexedHeight === head.indexedHeight &&
      previous.indexedHash !== undefined &&
      head.indexedHash !== undefined &&
      previous.indexedHash !== head.indexedHash;
    this.heads.set(head.domain, { head, version: ++this.version });
    const rollback =
      head.previousIndexedHeight !== undefined &&
      head.indexedHeight < head.previousIndexedHeight;
    if (rollback || replaced) this.revision++;
    for (const window of this.windows.values()) {
      if (window.domain !== head.domain) continue;
      if (replaced) {
        for (const cursor of window.cursors)
          this.fail(
            cursor.owner,
            new Error('Indexed block replaced without a rollback boundary'),
          );
        continue;
      }
      if (rollback) {
        window.revision++;
        this.clear(window);
      }
      for (const cursor of window.cursors) this.update(cursor, head);
      if (rollback && window.cursors.size) {
        window.floor = minimumPosition(window);
        window.through = window.floor;
      }
      this.schedule(window);
    }
  }

  private update(cursor: Cursor, head: HeadNotification) {
    if (head.headHeight === undefined || head.indexedHeight === undefined)
      return;
    cursor.target = confirmationHeight(
      { head: head.headHeight, indexed: head.indexedHeight },
      cursor.confirmations,
    );
    if (
      head.previousIndexedHeight === undefined ||
      head.indexedHeight >= head.previousIndexedHeight
    )
      return;
    cursor.boundary = undefined;
    if (cursor.owner.started && cursor.exposed > cursor.target)
      this.send(cursor, {
        type: 'rollback',
        eventType: cursor.eventType,
        domain: cursor.domain,
        confirmations: cursor.confirmations,
        fromHeight: cursor.exposed.toString(),
        toHeight: cursor.target.toString(),
      });
    cursor.exposed = cursor.target;
    if (cursor.position[0] > cursor.target)
      cursor.position = endOfHeight(cursor.target);
  }

  private send(cursor: Cursor, message: Record<string, unknown>) {
    if (!cursor.owner.active() || !cursor.owner.send(message))
      this.remove(cursor.owner);
  }

  private schedule(window: Window) {
    if (
      window.running ||
      this.stopped ||
      this.running >= this.limits.parallel ||
      !this.needsRead(window)
    )
      return;
    this.running++;
    window.running = true;
    void this.advance(window)
      .catch((error: unknown) => {
        this.cooldown(window, 0);
        for (const cursor of window.cursors) this.fail(cursor.owner, error);
      })
      .finally(() => {
        this.running--;
        window.running = false;
        // Rotate completed ranges for fairness. Idle windows are the queue;
        // disconnected clients leave no queued tasks or retained closures.
        if (this.windows.get(window.key) === window) {
          this.windows.delete(window.key);
          this.windows.set(window.key, window);
        }
        this.scheduleAvailable();
      });
  }

  private scheduleAvailable() {
    if (this.stopped) return;
    for (const window of this.windows.values()) {
      if (this.running >= this.limits.parallel) break;
      this.schedule(window);
    }
  }

  private needsRead(window: Window) {
    for (const cursor of window.cursors)
      if (
        cursor.owner.started &&
        cursor.owner.active() &&
        cursor.target > completedHeight(cursor)
      )
        return true;
    return false;
  }

  private async advance(window: Window) {
    if (
      !this.stopped &&
      this.windows.get(window.key) === window &&
      this.needsRead(window)
    ) {
      this.trim(window);
      const floor = minimumPosition(window);
      const prefix = floor < window.floor;
      let through = window.through;
      for (const cursor of window.cursors)
        if (cursor.owner.started && cursor.target > through)
          through = cursor.target;
      const after = prefix ? floor : window.through;
      const end = prefix ? window.floor : through;
      const lagging = [...window.cursors].filter(
        (cursor) => completedHeight(cursor) === floor,
      );
      for (const cursor of window.cursors)
        if (cursor.owner.started && cursor.target > cursor.exposed)
          cursor.exposed = cursor.target;
      if (end > after) {
        const revision = window.revision;
        const pending: CachedRow[] = [];
        let bytes = 0;
        try {
          for await (const row of this.store.confirmationEventRows(
            window.eventType,
            window.domain,
            endOfHeight(after),
            end,
          )) {
            if (
              this.stopped ||
              !window.cursors.size ||
              revision !== window.revision
            )
              break;
            const rowBytes = Buffer.byteLength(JSON.stringify(row.message));
            bytes += rowBytes;
            pending.push({ ...row, bytes: rowBytes });
            this.pendingBytes += rowBytes;
            this.pendingRows++;
            if (
              pending.length > Math.min(5_000, this.limits.rows) ||
              bytes > Math.min(4 * 1024 * 1024, this.limits.bytes)
            )
              throw new CapacityError();
          }
          if (this.stopped || !window.cursors.size) return;
          if (revision !== window.revision || (prefix && end !== window.floor))
            return;
          while (
            this.rows + pending.length > this.limits.rows ||
            this.bytes + bytes > this.limits.bytes
          ) {
            // An in-progress publication can free space without shedding a
            // subscriber. Publishers do not wait on pending scan admission.
            if (this.publications.size) {
              await Promise.race(this.publications);
              if (
                this.stopped ||
                !window.cursors.size ||
                revision !== window.revision ||
                (prefix && end !== window.floor)
              )
                return;
              continue;
            }
            // A new historical prefix must pay for itself. Growing live ranges
            // shed the policy retaining the largest cache, not an unrelated
            // zero-confirmation subscriber that happens to publish next.
            if (prefix || !this.evictRetainer()) throw new CapacityError();
            if (!window.cursors.size || revision !== window.revision) return;
          }
          window.rows = prefix
            ? [...pending, ...window.rows]
            : [...window.rows, ...pending];
          window.bytes += bytes;
          this.bytes += bytes;
          this.rows += pending.length;
          if (prefix) window.floor = floor;
          else window.through = end;
        } catch (error) {
          if (revision !== window.revision) return;
          // A deeper joining policy can fail its own prefix scan without
          // interrupting subscribers already served by the retained window.
          if (prefix || error instanceof CapacityError) {
            const affected = lagging.filter((cursor) =>
              window.cursors.has(cursor),
            );
            if (!affected.length) return;
            this.cooldown(
              window,
              Math.min(...affected.map((cursor) => cursor.confirmations)),
            );
            for (const cursor of affected) this.fail(cursor.owner, error);
            return;
          }
          throw error;
        } finally {
          this.pendingBytes -= bytes;
          this.pendingRows -= pending.length;
        }
      }
      const publication = this.publish(window)
        .then((completed) => {
          if (completed) this.trim(window);
        })
        .finally(() => {
          this.publications.delete(publication);
        });
      this.publications.add(publication);
      await publication;
    }
  }

  private async publish(window: Window): Promise<boolean> {
    const revision = window.revision;
    const cursors = [...window.cursors]
      .filter(
        (cursor) =>
          cursor.owner.started && completedHeight(cursor) >= window.floor,
      )
      .map((cursor) => ({
        cursor,
        target: cursor.target < window.through ? cursor.target : window.through,
      }));
    let sent = 0;
    let sentBytes = 0;
    for (const row of window.rows) {
      const frames = new Map<number, Record<string, unknown>>();
      for (const pass of cursors) {
        const { cursor } = pass;
        // Skipped rows also consume fanout work. Recheck ancestry after yielding.
        if (++sent >= 64 || sentBytes >= 256 * 1024) {
          sent = 0;
          sentBytes = 0;
          await nextTurn();
          if (
            this.stopped ||
            revision !== window.revision ||
            this.windows.get(window.key) !== window
          )
            return false;
        }
        if (cursor.target < pass.target) pass.target = cursor.target;
        if (
          !cursor.owner.started ||
          row.position[0] > pass.target ||
          comparePosition(row.position, cursor.position) <= 0
        )
          continue;
        cursor.position = row.position;
        if (row.position[0] > cursor.exposed) cursor.exposed = row.position[0];
        const frame = frames.get(cursor.confirmations) ?? {
          ...row.message,
          confirmations: cursor.confirmations,
        };
        frames.set(cursor.confirmations, frame);
        this.send(cursor, frame);
        sentBytes += row.bytes + 64;
      }
    }
    for (const { cursor, target } of cursors) {
      if (!cursor.owner.started) continue;
      const completed = cursor.target < target ? cursor.target : target;
      if (completed >= cursor.position[0])
        cursor.position = endOfHeight(completed);
    }
    return true;
  }

  private trim(window: Window) {
    if (!window.cursors.size) return;
    const floor = minimumPosition(window);
    if (floor <= window.floor) return;
    const removed = window.rows.filter((row) => row.position[0] <= floor);
    const bytes = removed.reduce((sum, row) => sum + row.bytes, 0);
    window.rows = window.rows.slice(removed.length);
    window.bytes -= bytes;
    this.bytes -= bytes;
    this.rows -= removed.length;
    window.floor = floor;
    if (floor > window.through) {
      // A newer checkpoint can outlive every reader of the skipped interval.
      window.through = floor;
      window.revision++;
    }
  }

  private evictRetainer(): boolean {
    let victim: { window: Window; retainers: Cursor[] } | undefined;
    for (const window of this.windows.values()) {
      const last = window.rows.at(-1);
      if (!last || (victim && window.bytes <= victim.window.bytes)) continue;
      const oldest = minimumPosition(window);
      const retainers = [...window.cursors].filter(
        (cursor) =>
          completedHeight(cursor) === oldest &&
          cursor.target < last.position[0],
      );
      if (retainers.length) victim = { window, retainers };
    }
    if (!victim) return false;
    this.cooldown(
      victim.window,
      Math.min(...victim.retainers.map((cursor) => cursor.confirmations)),
    );
    for (const cursor of victim.retainers) {
      if (victim.window.cursors.has(cursor))
        this.fail(cursor.owner, new CapacityError());
    }
    return true;
  }

  private cooldown(window: Window, confirmations: number) {
    const now = Date.now();
    const previous = this.retryAfter.get(window.key);
    this.retryAfter.set(window.key, {
      until: now + 30_000,
      confirmations:
        previous && previous.until > now
          ? Math.min(previous.confirmations, confirmations)
          : confirmations,
    });
  }

  private fail(owner: Subscriber, error: unknown) {
    this.remove(owner);
    owner.fail(error);
  }

  private remove(owner: Subscriber) {
    owner.started = false;
    for (const cursor of owner.cursors) {
      const key = `${cursor.eventType}:${cursor.domain}`;
      const window = this.windows.get(key);
      if (!window) continue;
      window.cursors.delete(cursor);
      if (window.cursors.size) this.trim(window);
      else {
        this.clear(window);
        this.windows.delete(key);
      }
    }
  }

  private clear(window: Window) {
    this.rows -= window.rows.length;
    this.bytes -= window.bytes;
    window.rows = [];
    window.bytes = 0;
  }

  stop() {
    this.stopped = true;
    for (const window of this.windows.values()) this.clear(window);
    this.windows.clear();
    this.heads.clear();
  }
}

function minimumPosition(window: Window) {
  let floor: bigint | undefined;
  for (const cursor of window.cursors) {
    const completed = completedHeight(cursor);
    if (floor === undefined || completed < floor) floor = completed;
  }
  return floor ?? window.through;
}

function completedHeight(cursor: Cursor) {
  const [height] = cursor.position;
  return cursor.position[1] === END_POSITION[1] ? height : height - 1n;
}

function comparePosition(a: Position, b: Position) {
  return a[0] < b[0]
    ? -1
    : a[0] > b[0]
      ? 1
      : a[2] < b[2]
        ? -1
        : a[2] > b[2]
          ? 1
          : 0;
}
