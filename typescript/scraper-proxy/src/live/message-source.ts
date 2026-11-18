// Per-process source for /messages. A browser owns only a projection cursor.
// Range scans are shared by domain. Only requested rows are hydrated.
import {
  confirmationHeight,
  endOfHeight,
  type ConfirmationHead,
} from './confirmation-stream.js';
import type { EventStore, MessageChange } from './event-store.js';
import { projectMessage, type MessageFacts } from './message-facts.js';
import {
  MAX_EXPLORER_CONFIRMATIONS,
  type HeadNotification,
} from './protocol.js';

const MAX_CHANGES = 50_000;
const MAX_FACT_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_DOMAINS = 4;
const FACT_BATCH_SIZE = 64;
const MAX_FACT_QUERIES = 2;
const DOMAIN_RETRY_MS = 30_000;

class MessageRangeCapacityError extends Error {
  constructor() {
    super('Message source range limit exceeded');
  }
}

// Every invalidation schedules its own refresh or advance, so callers retry.
class MessageSnapshotInvalidatedError extends Error {
  constructor() {
    super('Message snapshot invalidated during publication');
  }
}

type Head = ConfirmationHead & { hash?: string };
type Window = {
  floor: bigint;
  through: bigint;
  changes: MessageChange[];
  loading?: boolean;
};
type Entry = {
  refs: number;
  bytes: number;
  value?: Promise<MessageFacts | Error | undefined>;
  // Settled facts, kept to decide which entries a rollback can affect.
  facts?: MessageFacts;
  // Near-head transaction rows can arrive after the message without an
  // Explorer notification; reuse such facts only within the current read.
  stale?: boolean;
};

// Origin/destination transaction rows join after the dispatch or delivery.
function awaitingTransactions(facts: MessageFacts) {
  return (
    facts.pending.origin_tx_id === null ||
    facts.deliveries.some(({ fields }) => fields.destination_tx_id === null)
  );
}

// Share the same bounded FIFO admission rule for range scans and fact batches.
function limitReads(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active < limit) active++;
    else {
      if (queue.length >= 512)
        throw new Error('Message source read queue full');
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await read();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

type Policy = { confirmations: number; domains: Set<number> };
type Subscriber = Policy & {
  ids?: Set<string>;
  frontiers: Map<number, bigint>;
  exposed: Map<string, Map<number, bigint>>;
  send: (frame: Record<string, unknown>) => void;
  fail: (error: unknown) => void;
};

export class MessageSource {
  private readonly subscribers = new Set<Subscriber>();
  private readonly advances = new Map<number, { head: ConfirmationHead }>();
  private readonly heads = new Map<number, Head>();
  private snapshot?: Promise<Map<number, Head>>;
  private readonly retryAfter = new Map<number, number>();
  private readonly windows = new Map<number, Window>();
  private readonly entries = new Map<string, Entry>();
  private readonly projections = new WeakMap<
    MessageFacts,
    { key: string; row: ReturnType<typeof projectMessage> }
  >();
  private readonly scan = limitReads(MAX_PARALLEL_DOMAINS);
  private readonly hydrate = limitReads(MAX_FACT_QUERIES);
  private changes = 0;
  private bytes = 0;
  private stopped = false;

  constructor(
    private readonly store: Pick<
      EventStore,
      'messageHeads' | 'messageChanges' | 'messageFacts'
    >,
  ) {}

  metrics() {
    return {
      ranges: this.windows.size,
      changes: this.changes,
      factBytes: this.bytes,
    };
  }

  // Listen is established before this lazy snapshot. Notifications received
  // while the snapshot is running win, including rollbacks to a lower height.
  currentHeads() {
    this.snapshot ??= this.store
      .messageHeads()
      .then((rows) => {
        for (const [domain, head] of rows)
          if (!this.heads.has(domain)) this.heads.set(domain, head);
        return this.heads;
      })
      .catch((err: unknown) => {
        this.snapshot = undefined;
        this.heads.clear();
        throw err;
      });
    return this.snapshot;
  }

  observe(head: HeadNotification) {
    if (!this.snapshot) return;
    const previous = this.heads.get(head.domain);
    const indexed = head.indexedHeight ?? previous?.indexed;
    const tip = head.headHeight ?? previous?.head;
    if (indexed === undefined || tip === undefined) return;
    const next = {
      head: tip,
      indexed,
      confirmed: head.confirmedHeight,
      hash:
        head.indexedHash ??
        (previous?.indexed === indexed ? previous.hash : undefined),
    };
    this.heads.set(head.domain, next);
    const window = this.windows.get(head.domain);
    const replaced =
      previous?.indexed === indexed &&
      !!previous.hash &&
      !!next.hash &&
      previous.hash !== next.hash;
    if (
      replaced ||
      (head.previousIndexedHeight !== undefined &&
        indexed < head.previousIndexedHeight)
    ) {
      this.advances.delete(head.domain);
      if (window) this.dropWindow(head.domain, window);
      if (replaced) {
        for (const sub of this.subscribers)
          if (sub.frontiers.has(head.domain))
            sub.fail(
              new Error('Message block replaced without rollback boundary'),
            );
      }
      // Cross-domain projections can include a removed delivery/payment even
      // when the retained change is on a different domain. Settled facts list
      // every domain they read; anything else is invalidated conservatively.
      for (const entry of this.entries.values())
        if (!entry.facts || entry.facts.dependencies.has(head.domain))
          this.invalidate(entry);
    } else if (window && !window.loading) {
      // Retain unprocessed advances. A stalled domain cannot pin old rows forever.
      const floor = confirmationHeight(next, 2 * MAX_EXPLORER_CONFIRMATIONS);
      if (floor > window.through && !this.readsDomain(head.domain)) {
        this.dropWindow(head.domain, window);
        return;
      }
      this.trim(window, floor < window.through ? floor : window.through);
    }
  }

  invalidateIds(ids: readonly string[]) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this.invalidate(entry);
    }
  }

  private invalidate(entry: Entry) {
    this.bytes -= entry.bytes;
    entry.bytes = 0;
    entry.value = undefined;
    entry.facts = undefined;
    entry.stale = undefined;
  }

  private trim(window: Window, floor: bigint) {
    if (floor <= window.floor) return;
    let removed = 0;
    for (const change of window.changes) {
      if (change.height > floor) break;
      const entry = this.entries.get(change.id);
      if (entry) entry.refs--;
      removed++;
    }
    if (removed) window.changes = window.changes.slice(removed);
    this.changes -= removed;
    window.floor = floor;
  }

  private dropWindow(domain: number, window: Window) {
    if (this.windows.get(domain) !== window) return;
    this.windows.delete(domain);
    const last = window.changes.at(-1);
    if (last) this.trim(window, last.height);
  }

  private entry(id: string) {
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= MAX_CHANGES) {
        this.evictIdle();
        if (this.entries.size >= MAX_CHANGES)
          throw new MessageRangeCapacityError();
      }
      entry = { refs: 0, bytes: 0 };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private readsDomain(domain: number) {
    for (const sub of this.subscribers)
      if (sub.ids?.size !== 0 && sub.frontiers.has(domain)) return true;
    return false;
  }

  private evictIdle() {
    // An idle or offline domain may never send another head to trim its window.
    for (const [domain, window] of this.windows)
      if (!this.advances.has(domain) && !this.readsDomain(domain))
        this.dropWindow(domain, window);
    for (const [id, entry] of this.entries) {
      if (entry.refs || (entry.value && !entry.bytes)) continue;
      this.invalidate(entry);
      this.entries.delete(id);
    }
  }

  private fetchBatch(batch: { id: string; entry: Entry }[]) {
    // Read every scheduled ID. A filtered ID would be cached as a missing
    // message and served to a later subscriber that does want it.
    const result = this.hydrate(async () =>
      this.stopped
        ? new Map<string, MessageFacts | Error>()
        : this.store.messageFacts(batch.map(({ id }) => id)),
    );
    for (const { id, entry } of batch) {
      const value = result
        .then((rows) => {
          const facts = rows.get(id);
          if (entry.value === value) {
            const bytes = facts instanceof Error ? 1 : (facts?.bytes ?? 1);
            if (this.bytes + bytes > MAX_FACT_BYTES) this.evictIdle();
            if (this.bytes + bytes > MAX_FACT_BYTES)
              throw new Error('Message source byte limit exceeded');
            entry.bytes = bytes;
            this.bytes += bytes;
            if (facts && !(facts instanceof Error)) {
              entry.facts = facts;
              entry.stale = awaitingTransactions(facts);
            }
          }
          return facts;
        })
        .catch((err: unknown) => {
          if (entry.value === value) this.invalidate(entry);
          throw err;
        });
      entry.value = value;
    }
  }

  private async prepare(
    domain: number,
    after: bigint,
    head: ConfirmationHead,
  ): Promise<Window> {
    let window = this.windows.get(domain);
    if (!window) {
      const floor = after;
      window = { floor, through: floor, changes: [] };
      this.windows.set(domain, window);
    }
    const through = confirmationHeight(head, 0);
    if (after < window.floor || window.through < through) {
      const current = window;
      current.loading = true;
      try {
        await this.scan(async () => {
          const active = () =>
            !this.stopped &&
            this.windows.get(domain) === current &&
            this.readsDomain(domain);
          if (!active()) return;
          const start = after < current.floor ? after : current.through;
          const end = after < current.floor ? current.floor : through;
          const prefix: MessageChange[] = [];
          let installed = false;
          try {
            for await (const page of this.store.messageChanges(
              domain,
              endOfHeight(start),
              end,
            )) {
              if (!active()) return;
              if (this.changes + page.length > MAX_CHANGES) this.evictIdle();
              if (this.changes + page.length > MAX_CHANGES)
                throw new MessageRangeCapacityError();
              for (const change of page) {
                const entry = this.entry(change.id);
                entry.refs++;
                this.invalidate(entry);
                prefix.push(change);
                this.changes++;
              }
              // Check before the iterator can issue its next page query.
              if (!active()) return;
            }
            if (!active()) return;
            if (start < current.floor) {
              current.changes = [...prefix, ...current.changes];
              current.floor = start;
            } else {
              current.changes = [...current.changes, ...prefix];
              current.through = through;
            }
            installed = true;
          } finally {
            if (!installed)
              for (const change of prefix) {
                const entry = this.entries.get(change.id);
                if (entry) entry.refs--;
                this.changes--;
              }
          }
        });
      } finally {
        current.loading = false;
      }
    }
    if (
      this.readsDomain(domain) &&
      this.windows.get(domain) === window &&
      window.through < through
    )
      return this.prepare(domain, after, head);
    return window;
  }

  subscribe(
    policy: Policy,
    ids: Set<string> | undefined,
    send: Subscriber['send'],
    fail: Subscriber['fail'],
  ) {
    const frontiers = new Map<number, bigint>();
    for (const domain of policy.domains) {
      const head = this.heads.get(domain);
      if (head)
        frontiers.set(domain, confirmationHeight(head, policy.confirmations));
    }
    const sub: Subscriber = {
      ...policy,
      ids,
      send,
      fail,
      frontiers,
      exposed: new Map(),
    };
    this.subscribers.add(sub);
    return {
      customDomains: [...frontiers.keys()],
      canonicalDomains: [...policy.domains].filter((d) => !frontiers.has(d)),
      unsubscribe: () => {
        this.subscribers.delete(sub);
        for (const domain of frontiers.keys()) {
          if (this.readsDomain(domain)) continue;
          this.advances.delete(domain);
          const window = this.windows.get(domain);
          if (window) this.dropWindow(domain, window);
        }
      },
    };
  }

  notify(event: HeadNotification) {
    const { domain, indexedHeight, headHeight, confirmedHeight } = event;
    if (indexedHeight === undefined || headHeight === undefined) return;
    const head = {
      indexed: indexedHeight,
      head: headHeight,
      confirmed: confirmedHeight,
    };
    const rollback =
      event.previousIndexedHeight !== undefined &&
      indexedHeight < event.previousIndexedHeight;
    const refresh = new Map<Subscriber, Set<string>>();
    let needed = false;
    for (const sub of this.subscribers) {
      const from = sub.frontiers.get(domain);
      if (from === undefined) continue;
      const to = confirmationHeight(head, sub.confirmations);
      if (rollback && to < from) {
        sub.frontiers.set(domain, to);
        sub.send({
          type: 'rollback',
          domain,
          confirmations: sub.confirmations,
          fromHeight: String(from),
          toHeight: String(to),
        });
        // Rows whose facts on this domain are all at or below `to` are intact.
        const ids = new Set<string>();
        for (const [id, deps] of sub.exposed)
          if ((deps.get(domain) ?? to) > to) ids.add(id);
        if (ids.size) refresh.set(sub, ids);
      }
      if (to > from && sub.ids?.size !== 0) needed = true;
      if (sub.ids?.size === 0) sub.frontiers.set(domain, to);
      if (event.previousConfirmedHeight !== confirmedHeight)
        for (const [id, deps] of sub.exposed) {
          if (
            [...deps].every(
              ([d, height]) => height <= (this.heads.get(d)?.confirmed ?? 0n),
            )
          )
            sub.exposed.delete(id);
        }
    }
    if (refresh.size)
      void this.refresh(
        [...new Set([...refresh.values()].flatMap((ids) => [...ids]))],
        refresh,
      );
    const pending = this.advances.get(domain);
    if (pending) pending.head = head;
    else if (needed && (this.retryAfter.get(domain) ?? 0) <= Date.now()) {
      this.retryAfter.delete(domain);
      const work = { head };
      this.advances.set(domain, work);
      void this.advance(domain, work);
    }
  }

  private async advance(domain: number, work: { head: ConfirmationHead }) {
    try {
      while (this.advances.get(domain) === work) {
        const head = work.head;
        const ranges = [...this.subscribers].flatMap((sub) => {
          const from = sub.frontiers.get(domain);
          const to = confirmationHeight(head, sub.confirmations);
          return from !== undefined && from < to && sub.ids?.size !== 0
            ? [{ sub, from, to }]
            : [];
        });
        if (!ranges.length) return;
        const after = ranges.reduce(
          (min, r) => (r.from < min ? r.from : min),
          ranges[0].from,
        );
        let window: Window;
        try {
          window = await this.prepare(domain, after, head);
        } catch (error) {
          if (!(error instanceof MessageRangeCapacityError)) throw error;
          const retained = this.windows.get(domain);
          if (retained && retained.floor === retained.through)
            this.dropWindow(domain, retained);
          // The deepest cursor owns an expansion that does not fit. Preserve
          // the existing window and let shallower subscribers advance.
          for (const { sub, from } of ranges)
            if (from === after) {
              this.subscribers.delete(sub);
              sub.fail(error);
            }
          continue;
        }
        if (this.advances.get(domain) !== work) return;
        // Keep one range per domain. Store only two indexes per subscriber,
        // even when every browser subscribes to the same busy chain.
        const changes = window.changes;
        const ids = new Set<string>();
        const releases = ranges.flatMap(({ sub, from, to }) => {
          if (!this.subscribers.has(sub)) return [];
          if (from < window.floor) {
            sub.fail(new Error('Message cursor fell behind retained range'));
            return [];
          }
          const start = firstAfter(changes, from),
            end = firstAfter(changes, to);
          for (let i = start; i < end; i++) {
            const id = changes[i].id;
            if (!sub.ids || sub.ids.has(id)) ids.add(id);
          }
          return [{ sub, to, start, end }];
        });
        let facts: Map<string, MessageFacts | Error | undefined>;
        try {
          facts = await this.load(ids);
        } catch (error) {
          if (error instanceof MessageSnapshotInvalidatedError) continue;
          throw error;
        }
        if (this.advances.get(domain) !== work) return;
        for (const { sub, to, start, end } of releases) {
          if (
            !this.subscribers.has(sub) ||
            to > confirmationHeight(work.head, sub.confirmations)
          )
            continue;
          sub.frontiers.set(domain, to);
          const fields = { domain, height: String(to) };
          const sent = new Set<string>();
          for (let i = start; i < end && this.subscribers.has(sub); i++) {
            const id = changes[i].id;
            if ((!sub.ids || sub.ids.has(id)) && !sent.has(id)) {
              sent.add(id);
              this.upsert(sub, id, facts.get(id), fields);
            }
          }
        }
        if (head === work.head) return;
      }
    } catch {
      // Frontiers have not moved, so subscribers lose nothing by waiting.
      // Back off instead of rescanning a failing domain on every head.
      if (this.advances.get(domain) === work) {
        this.retryAfter.set(domain, Date.now() + DOMAIN_RETRY_MS);
        const window = this.windows.get(domain);
        if (window) this.dropWindow(domain, window);
      }
    } finally {
      if (this.advances.get(domain) === work) this.advances.delete(domain);
    }
  }

  private async load(ids: Iterable<string>) {
    const reads: { id: string; entry: Entry }[] = [];
    try {
      for (const id of ids) {
        const entry = this.entry(id);
        entry.refs++;
        if (entry.stale) this.invalidate(entry);
        reads.push({ id, entry });
      }
      // Recheck the entire batch after the last read settles. A receipt or fork
      // can invalidate an early result while another ID is still loading.
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
        const missing = reads.filter(({ entry }) => !entry.value);
        for (let i = 0; i < missing.length; i += FACT_BATCH_SIZE)
          this.fetchBatch(missing.slice(i, i + FACT_BATCH_SIZE));
        const pending = reads.map(({ entry }) => {
          if (!entry.value) throw new Error('Missing scheduled message read');
          return entry.value;
        });
        const rows = await Promise.all(pending);
        if (reads.every(({ entry }, i) => entry.value === pending[i]))
          return new Map(reads.map(({ id }, i) => [id, rows[i]]));
      }
      throw new MessageSnapshotInvalidatedError();
    } finally {
      for (const { entry } of reads) entry.refs--;
    }
  }

  // `rollback` selects ids per subscriber when the rollback is observed; a
  // later advance can move the frontier before these facts load.
  async refresh(ids: string[], rollback?: Map<Subscriber, Set<string>>) {
    const recipients = [...(rollback?.keys() ?? this.subscribers)];
    const interested = (sub: Subscriber, id: string) =>
      (!sub.ids || sub.ids.has(id)) &&
      (!rollback || !!rollback.get(sub)?.has(id));
    const selected = ids.filter((id) =>
      recipients.some((sub) => interested(sub, id)),
    );
    if (!selected.length) return;
    try {
      let facts: Map<string, MessageFacts | Error | undefined> | undefined;
      while (!facts && !this.stopped) {
        try {
          facts = await this.load(selected);
        } catch (error) {
          if (!(error instanceof MessageSnapshotInvalidatedError)) throw error;
        }
      }
      if (!facts) return;
      for (const sub of recipients)
        for (const [id, row] of facts) {
          if (!this.subscribers.has(sub)) break;
          if (
            interested(sub, id) &&
            row &&
            (rollback ||
              row instanceof Error ||
              sub.domains.has(row.origin) ||
              sub.domains.has(row.destination))
          )
            this.upsert(sub, id, row);
        }
    } catch (error) {
      for (const sub of recipients)
        if (
          this.subscribers.has(sub) &&
          selected.some((id) => interested(sub, id))
        )
          sub.fail(error);
    }
  }

  private upsert(
    sub: Subscriber,
    id: string,
    facts: MessageFacts | Error | undefined,
    fields?: Record<string, unknown>,
  ) {
    if (facts instanceof Error) {
      sub.exposed.delete(id);
      if (sub.ids) sub.fail(facts);
      else
        sub.send({
          type: 'error',
          messageId: id,
          error: facts.message,
        });
      return;
    }
    const row = facts && this.project(facts, sub, id);
    if (!row) {
      sub.exposed.delete(id);
      return;
    }
    const deps = new Map<number, bigint>();
    for (const [d, height] of row.heights)
      if (sub.frontiers.has(d) && height > (this.heads.get(d)?.confirmed ?? 0n))
        deps.set(d, height);
    if (deps.size) sub.exposed.set(id, deps);
    else sub.exposed.delete(id);
    if (sub.exposed.size > 10_000) {
      sub.fail(new Error('Custom provisional message limit exceeded'));
      return;
    }
    sub.send({
      type: 'message_upsert',
      confirmations: sub.confirmations,
      ...fields,
      data: row.data,
    });
  }

  private project(facts: MessageFacts, sub: Subscriber, id: string) {
    const frontier = (domain: number) =>
      sub.frontiers.get(domain) ?? this.heads.get(domain)?.confirmed;
    const key = [...facts.dependencies]
      .map((domain) => frontier(domain)?.toString() ?? '*')
      .join(',');
    const previous = this.projections.get(facts);
    if (previous?.key === key) return previous.row;
    try {
      const row = projectMessage(facts, frontier);
      this.projections.set(facts, { key, row });
      return row;
    } catch (error) {
      // A delayed cursor may fall inside an aggregated payment bucket.
      // Like an invalid fact, this affects one ID, not a global stream.
      if (sub.ids) sub.fail(error);
      else
        sub.send({
          type: 'error',
          messageId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      return undefined;
    }
  }

  stop() {
    this.stopped = true;
    this.advances.clear();
    this.subscribers.clear();
    for (const [domain, window] of this.windows)
      this.dropWindow(domain, window);
    for (const entry of this.entries.values()) this.invalidate(entry);
    this.entries.clear();
  }
}

function firstAfter(changes: MessageChange[], height: bigint): number {
  let lo = 0,
    hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (changes[mid].height <= height) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
